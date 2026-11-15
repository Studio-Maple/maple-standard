/**
 * lib.mjs — shared helpers for the pre-deploy gate (D060 / predeploy-gate.md).
 * Zero dependencies. Everything that touches git, the state directory, the
 * config or hashing lives here so the gate, the verifier, the hook and the
 * live scanner can never disagree about where a stamp is or what a hash is.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnAsync } from "./proc.mjs";

export const SEVERITIES = ["info", "low", "medium", "high", "critical"];
export const GATE_VERSION = 1;

export function sevRank(s) {
  const i = SEVERITIES.indexOf(String(s || "").toLowerCase());
  return i < 0 ? SEVERITIES.indexOf("high") : i;
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** Deterministic JSON: keys sorted at every depth. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

export function git(root, args, opts = {}) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], ...opts }).trim();
  } catch {
    return null;
  }
}

/** Nearest ancestor of `start` holding maple.config.json (else null). */
export function findProjectRoot(start) {
  let dir = resolve(start || process.cwd());
  for (;;) {
    if (existsSync(join(dir, "maple.config.json"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function loadMapleConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, "maple.config.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Shared (all worktrees) state dir: <git-common-dir>/maple/predeploy. */
export function stateDir(root) {
  const common = git(root, ["rev-parse", "--git-common-dir"]);
  if (!common) throw new Error("not a git repository: " + root);
  const abs = isAbsolute(common) ? common : resolve(root, common);
  const dir = join(abs, "maple", "predeploy");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function headSha(root) {
  return git(root, ["rev-parse", "HEAD"]);
}

/** True when tracked files differ from HEAD (untracked files are the repo's .gitignore business). */
export function trackedDirty(root) {
  const out = git(root, ["status", "--porcelain", "--untracked-files=no"]);
  return out === null ? true : out.length > 0;
}

export function nowIso() {
  return new Date().toISOString();
}

/** Resolve a command on PATH ("" when missing). Handles Windows .exe/.cmd shims. */
export function which(cmd) {
  const probe = process.platform === "win32" ? "where" : "which";
  const r = spawnSync(probe, [cmd], { encoding: "utf8" });
  if (r.status !== 0) return "";
  return String(r.stdout).split(/\r?\n/).find(Boolean) || "";
}

export function shellBin() {
  return process.env.MAPLE_SHELL || "bash";
}

const SHELL_MAX_BUFFER = 512 * 1024 * 1024;
const shellOpts = ({ cwd, env, timeoutSec }) => ({ cwd, env: { ...process.env, ...(env || {}) }, maxBuffer: SHELL_MAX_BUFFER, timeout: timeoutSec * 1000 });

/** Run a shell command string; never throws. Blocks the event loop: inside a gate check use runShellAsync. */
export function runShell(command, { cwd, env, timeoutSec = 900 } = {}) {
  return shellResult(spawnSync(shellBin(), ["-c", command], { ...shellOpts({ cwd, env, timeoutSec }), encoding: "utf8" }));
}

/** runShell without blocking the event loop (so the gate's checks really overlap). Same result shape; never rejects. */
export async function runShellAsync(command, { cwd, env, timeoutSec = 900 } = {}) {
  return shellResult(await spawnAsync(shellBin(), ["-c", command], { ...shellOpts({ cwd, env, timeoutSec }), msysShell: shellBin() }));
}

function shellResult(r) {
  return {
    status: r.status,
    signal: r.signal,
    timedOut: r.error?.code === "ETIMEDOUT",
    spawnError: r.error && r.error.code !== "ETIMEDOUT" ? String(r.error.message) : null,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  };
}

export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
