#!/usr/bin/env node
/**
 * heavy-run.mjs - the SCHEDULED heavy gate (D066). Run daily (Windows Task Scheduler, see docs/quality.md) or by hand.
 *
 *   node heavy-run.mjs [--root DIR] [--remote origin] [--target BRANCH] [--command CMD] [--force] [--timeout-min 180]
 *
 * It never touches the owner's checkout or dev server: it
 *   1. fetches <remote>/<target> (repo.devBranch, else repo.prodBranch, else main) and takes its tip sha;
 *   2. exits at once when that exact sha already has a green heavy stamp (unless --force);
 *   3. takes <git-common-dir>/maple/heavy-run.lock (never from a live pid; a dead holder's lock is reclaimed);
 *   4. adds a detached temporary worktree <main-root>/.worktrees/_heavy-<sha8> (node_modules junctioned from
 *      the main checkout, D012) and runs the heavy command there (maple.config.json ci.tiers.heavy, default
 *      `pnpm ci:heavy`) with its output streamed to a log;
 *   5. classifies the run - green (the command exited 0 AND wrote heavy-pass/<sha>.json, which also pays gate
 *      debt), partial (exited 0 but no stamp: a step was skipped), red (non-zero), timeout - and writes
 *      <git-common-dir>/maple/heavy-runs/<ts>-<sha8>.json (+ .log);
 *   6. ALWAYS removes the temporary worktree via maple_remove_worktree (strips junctions/reparse points first,
 *      so a recursive delete can never follow a link into the main checkout - D012).
 * Exit: 0 green or already green; 1 red/partial/timeout; 2 could not run.
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findBash, toPosix } from "./find-bash.mjs";
import { git, mapleDir, readHeavyStamp, sub } from "./gate-state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAPLE_LIB = join(HERE, "..", "agent-wt", "maple-lib.sh");

const alive = (pid) => {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === "EPERM"; }
};

/** Take the run lock. Never from a live pid; a dead holder (or a pid-less dir older than graceSec) is reclaimed. */
export function takeLock(root, { graceSec = 120, pid = process.pid } = {}) {
  const dir = join(mapleDir(root), "heavy-run.lock");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), `${pid}\n`);
      return { ok: true, dir };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let holder = "";
    try { holder = readFileSync(join(dir, "pid"), "utf8").trim(); } catch { /* no pid yet */ }
    if (/^\d+$/.test(holder)) {
      if (alive(holder)) return { ok: false, holder, reason: `a heavy run is already in progress (pid ${holder})` };
    } else {
      let age = 0;
      try { age = (Date.now() - statSync(dir).mtimeMs) / 1000; } catch { /* gone */ }
      if (age < graceSec) return { ok: false, holder: "?", reason: "a heavy run is starting (lock has no pid yet)" };
    }
    rmSync(dir, { recursive: true, force: true }); // dead holder: reclaim, then retry the mkdir
  }
  return { ok: false, holder: "?", reason: "could not take the heavy-run lock" };
}

export function releaseLock(lock) {
  if (lock?.dir) rmSync(lock.dir, { recursive: true, force: true });
}

function bashCall(root, script, args = []) {
  return spawnSync(findBash(), ["-c", script, "_", ...args], { cwd: root, encoding: "utf8" });
}

/** Add the detached temp worktree with node_modules/env linked (reusing maple-lib, D012). */
function addWorktree(root, wt, sha) {
  const add = spawnSync("git", ["worktree", "add", "--detach", wt, sha], { cwd: root, encoding: "utf8" });
  if (add.status !== 0) throw new Error("git worktree add failed: " + (add.stderr || add.stdout));
  const link = bashCall(root, `. "$1"; maple_link_node_modules "$2"; maple_link_env_files "$2"`, [toPosix(MAPLE_LIB), toPosix(wt)]);
  if (link.status !== 0) throw new Error("linking node_modules failed: " + (link.stderr || "").slice(0, 400));
}

/** Remove a worktree this script made. Refuses anything that is not <root>/.worktrees/_heavy-*. */
export function removeWorktree(root, wt) {
  const rel = toPosix(wt).toLowerCase();
  const allowed = toPosix(join(root, ".worktrees", "_heavy-")).toLowerCase();
  if (!rel.startsWith(allowed)) throw new Error(`refusing to remove ${wt}: not a _heavy-* worktree under ${root}/.worktrees`);
  if (existsSync(wt)) {
    const rm = bashCall(root, `. "$1"; maple_remove_worktree "$2"`, [toPosix(MAPLE_LIB), toPosix(wt)]);
    // D069: removal is fail-closed (nothing deleted when links can't be proven stripped) - say so, never pretend.
    if (rm.status !== 0) console.error(`heavy-run: KEPT temporary worktree ${wt} - removal refused (${String(rm.stderr || "").trim().split("
").slice(-1)[0] || "see above"}). Delete it by hand.`);
  }
  spawnSync("git", ["worktree", "prune"], { cwd: root });
}

function killTree(child) {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else try { child.kill("SIGKILL"); } catch { /* gone */ }
}

function tailOf(file, lines) {
  try { return readFileSync(file, "utf8").split(/\r?\n/).slice(-lines).join("\n"); } catch { return ""; }
}

function pruneOld(dir, days = 30) {
  const cutoff = Date.now() - days * 86400_000;
  for (const f of readdirSync(dir)) {
    try { if (statSync(join(dir, f)).mtimeMs < cutoff) rmSync(join(dir, f), { force: true }); } catch { /* best effort */ }
  }
}

function parseArgs(argv) {
  const a = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--force") a.force = true;
    else if (["--root", "--remote", "--target", "--command", "--timeout-min"].includes(v)) a[v.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else { console.error(`unknown argument: ${v}`); process.exit(2); }
  }
  return a;
}

/** @returns {Promise<number>} exit code */
export async function main(argv, log = console.log) {
  const args = parseArgs(argv);
  const start = resolve(args.root || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const common = git(start, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) { console.error("heavy-run: not a git repository: " + start); return 2; }
  const root = dirname(common); // the MAIN checkout (a worktree's common dir is the main .git)

  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(root, "maple.config.json"), "utf8")); } catch { /* defaults */ }
  const remote = args.remote || cfg.repo?.remote || "origin";
  const target = args.target || cfg.repo?.devBranch || cfg.repo?.prodBranch || "main";
  const command = args.command || cfg.ci?.tiers?.heavy || "pnpm ci:heavy";
  const timeoutMs = Number(args.timeoutMin || 180) * 60_000;

  const f = spawnSync("git", ["fetch", "--no-tags", "-q", remote, target], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (f.status !== 0) { console.error(`heavy-run: fetch of ${remote}/${target} failed: ${(f.stderr || "").trim()}`); return 2; }
  const sha = git(root, ["rev-parse", `${remote}/${target}`]);
  if (!sha) { console.error(`heavy-run: ${remote}/${target} does not resolve`); return 2; }
  if (!args.force && readHeavyStamp(root, sha)) { log(`heavy-run: ${sha.slice(0, 10)} already has a green heavy stamp - nothing to do`); return 0; }

  const lock = takeLock(root);
  if (!lock.ok) { log(`heavy-run: ${lock.reason} - not starting a second one`); return 0; }

  const runs = sub(root, "heavy-runs");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = join(runs, `${stamp}-${sha.slice(0, 8)}`);
  const logFile = `${base}.log`;
  const wt = join(root, ".worktrees", `_heavy-${sha.slice(0, 8)}`);
  const report = { sha, remote, target, command, startedAt: new Date().toISOString(), worktree: wt, log: logFile, status: "error" };
  let code = 2;
  try {
    mkdirSync(join(root, ".worktrees"), { recursive: true });
    if (existsSync(wt)) removeWorktree(root, wt); // a leftover from a killed run
    addWorktree(root, wt, sha);
    log(`heavy-run: ${sha.slice(0, 10)} (${remote}/${target}) in ${wt}\n  command: ${command}\n  log: ${logFile}`);

    const out = createWriteStream(logFile);
    const child = spawn(findBash(), ["-c", command], { cwd: wt, env: { ...process.env, MAPLE_HEAVY_RUN: "1", CI: process.env.CI || "" }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const exit = await new Promise((res) => { child.on("close", (c) => res(c)); child.on("error", () => res(127)); });
    clearTimeout(timer);
    await new Promise((res) => out.end(res));

    report.exit = exit;
    report.endedAt = new Date().toISOString();
    const stampRec = readHeavyStamp(root, sha);
    if (timedOut) { report.status = "timeout"; code = 1; }
    else if (exit !== 0) { report.status = "red"; code = 1; }
    else if (!stampRec) { report.status = "partial"; code = 1; } // exit 0 without a stamp: a step was skipped (gate debt recorded)
    else { report.status = "green"; report.stamp = stampRec.at; code = 0; }
    if (report.status !== "green") report.tail = tailOf(logFile, 40);
  } catch (e) {
    report.status = "error";
    report.error = String(e.message || e);
    code = 2;
    console.error("heavy-run: " + report.error);
  } finally {
    try { removeWorktree(root, wt); } catch (e) { report.cleanupError = String(e.message || e); console.error("heavy-run: " + report.cleanupError); }
    releaseLock(lock);
    report.endedAt = report.endedAt || new Date().toISOString();
    const tmp = `${base}.json.tmp`;
    writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n");
    renameSync(tmp, `${base}.json`);
    pruneOld(runs);
  }
  log(`heavy-run: ${report.status.toUpperCase()} for ${sha.slice(0, 10)} - report ${base}.json`);
  if (report.tail) log(report.tail);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
