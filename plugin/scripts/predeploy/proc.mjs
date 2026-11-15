/**
 * proc.mjs — non-blocking child processes for the pre-deploy gate, plus the bounded pool and mutex the gate schedules
 * them with.
 *
 * Why: the gate runs its checks through `pool(checks, concurrency)`, but every check used to launch its tool with
 * `spawnSync`, which blocks the whole Node event loop. The pool was therefore serial in practice, and the few truly
 * async checks (Supabase advisors, deps-freshness, the remote poll) were only resumed when every worker was parked,
 * so their recorded time included all the waiting (the audit saw "advisors: 29 min" for a 6 s check).
 *
 * `spawnAsync` is a drop-in for `spawnSync(bin, args, { encoding: "utf8", ... })`: same result shape
 * ({ status, signal, error, stdout, stderr }) and the same failure semantics:
 *   - timeout   -> child killed, status null, signal "SIGTERM", error.code "ETIMEDOUT"
 *   - maxBuffer -> child killed, status null, signal "SIGTERM", error.code "ENOBUFS", output truncated to maxBuffer
 *   - spawn failure (ENOENT ...) -> status null, error set, message "spawnSync <bin> <CODE>" like spawnSync's
 * One deliberate difference: on Windows a timeout kills the whole process TREE (MSYS sweep when `msysShell` is given,
 * then taskkill /T /F), where spawnSync killed only the direct child (bash) and left the real tool running (a left-over
 * trivy keeps its cache lock). On POSIX the direct child gets SIGTERM, as before (a detached process group would
 * survive Ctrl-C of the gate).
 * Extra option: { msysShell } = the bash that ran the command (runShellAsync passes it).
 */
import { spawn } from "node:child_process";

const KILL_GRACE_MS = 1500;

function makeError(bin, args, code, message) {
  return Object.assign(new Error(message || `spawnSync ${bin} ${code}`), { code, errno: code, syscall: `spawnSync ${bin}`, path: bin, spawnargs: args });
}

/**
 * MSYS/Git-Bash fork+exec breaks the Windows parent chain (a backgrounded or piped command's Windows parent is a
 * short-lived fork stub), so `taskkill /T` alone misses those processes. This sweep walks MSYS's own process table
 * (/proc/<pid>/{winpid,ppid}, read with shell builtins only) from the process whose Windows pid is `winpid` and
 * SIGKILLs it and every MSYS descendant (native Windows children of MSYS processes are in /proc too).
 */
const MSYS_SWEEP = 'w=$1; root=; for d in /proc/[0-9]*; do read -r x < "$d/winpid" 2>/dev/null && [ "$x" = "$w" ] && root=${d#/proc/}; done; '
  + '[ -n "$root" ] || exit 0; set -- "$root"; all=; '
  + 'while [ $# -gt 0 ]; do p=$1; shift; all="$all $p"; for d in /proc/[0-9]*; do read -r x < "$d/ppid" 2>/dev/null && [ "$x" = "$p" ] && set -- "$@" "${d#/proc/}"; done; done; '
  + 'kill -9 $all 2>/dev/null; exit 0';

function killTree(child, msysShell) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    return;
  }
  const taskkill = () => {
    try { spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true }).on("error", () => child.kill()); } catch { child.kill(); }
  };
  if (!msysShell) return taskkill();
  // Sweep first (while the root still exists to anchor the walk), then taskkill the native tree.
  let sweep;
  try { sweep = spawn(msysShell, ["-c", MSYS_SWEEP, "sweep", String(child.pid)], { stdio: "ignore", windowsHide: true }); } catch { return taskkill(); }
  const guard = setTimeout(() => { try { sweep.kill(); } catch { /* gone */ } }, 10000);
  let once = false;
  const next = () => { if (once) return; once = true; clearTimeout(guard); taskkill(); };
  sweep.on("exit", next);
  sweep.on("error", next);
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{cwd?:string, env?:object, input?:string|Buffer, shell?:boolean, timeout?:number, maxBuffer?:number, windowsHide?:boolean}} [o]
 *   timeout in ms (0/undefined = none); maxBuffer in bytes per stream (default 1 MiB, as spawnSync).
 * @returns {Promise<{status:number|null, signal:string|null, error?:Error, stdout:string, stderr:string, pid?:number}>}
 *   Never rejects.
 */
export function spawnAsync(bin, args = [], o = {}) {
  const maxBuffer = o.maxBuffer ?? 1024 * 1024;
  return new Promise((resolveRun) => {
    const bufs = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let settled = false;
    let failure = null; // "ETIMEDOUT" | "ENOBUFS"
    let timer = null;
    let graceTimer = null;
    let child;
    const finish = (status, signal, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      const text = (k) => Buffer.concat(bufs[k]).toString("utf8");
      const r = { status, signal, stdout: text("stdout"), stderr: text("stderr"), pid: child?.pid };
      if (error) r.error = error;
      resolveRun(r);
    };
    const abort = (code) => {
      if (failure || settled) return;
      failure = code;
      killTree(child, o.msysShell);
      // A grandchild may still hold the pipes open after the kill: never wait for 'close' forever.
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null, "SIGTERM", makeError(bin, args, failure));
      }, KILL_GRACE_MS);
    };
    try {
      child = spawn(bin, args, {
        cwd: o.cwd, env: o.env, shell: o.shell || false, windowsHide: o.windowsHide ?? true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return finish(null, null, makeError(bin, args, e.code || "EINVAL", e.code ? `spawnSync ${bin} ${e.code}` : String(e.message)));
    }
    for (const k of ["stdout", "stderr"]) {
      child[k].on("data", (chunk) => {
        if (failure) return;
        const room = maxBuffer - sizes[k];
        if (chunk.length > room) {
          if (room > 0) bufs[k].push(chunk.subarray(0, room));
          sizes[k] = maxBuffer;
          abort("ENOBUFS");
          return;
        }
        sizes[k] += chunk.length;
        bufs[k].push(chunk);
      });
      child[k].on("error", () => { /* destroyed after a kill */ });
    }
    child.stdin.on("error", () => { /* child exited before reading its input (EPIPE) */ });
    if (o.input !== undefined && o.input !== null) child.stdin.end(o.input);
    else child.stdin.end();
    if (o.timeout && o.timeout > 0) timer = setTimeout(() => abort("ETIMEDOUT"), o.timeout);
    child.on("error", (e) => {
      if (failure) return; // the kill itself
      finish(null, null, makeError(bin, args, e.code || "EUNKNOWN", e.code ? `spawnSync ${bin} ${e.code}` : String(e.message)));
    });
    child.on("close", (status, signal) => {
      if (failure) finish(null, "SIGTERM", makeError(bin, args, failure));
      else finish(status, signal);
    });
  });
}

/**
 * Run fn over items with at most n in flight; results keep the ITEM order (out[k] = fn(items[k])), whatever order the
 * work finishes in, so reports stay deterministic.
 */
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const width = Math.max(1, Math.min(Math.floor(n) || 1, items.length));
  await Promise.all(Array.from({ length: items.length ? width : 0 }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/** A FIFO mutex: `await lock.run(fn)` runs fn when no other fn of this lock is running. */
export function mutex() {
  let tail = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(() => fn());
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}

/**
 * One trivy at a time in this process: trivy's cache is a single-writer bolt DB, so a trivy-fs check overlapping a
 * trivy-image scan would fail on the cache lock. trivy-image takes it per scan; check-runner takes it for any other
 * check that needs the trivy tool.
 */
export const TRIVY_LOCK = mutex();

export const sleep =(ms) => new Promise((r) => setTimeout(r, ms));
