#!/usr/bin/env node
/**
 * ci-stack.mjs - the isolated, throwaway Supabase stack behind the heavy tier (D071).
 *
 * WHY. The heavy tier used to test against the owner's own dev stack: it held migrations of unlanded branches (types-freshness
 * went red) and `db reset` destroyed the owner's local data. Heavy must never depend on, or touch, a dev stack.
 *
 * WHAT. maple.config.json `ci.stack {projectId?, portBase}` -> a COPY of supabase/ in <git-common-dir>/maple/ci-stack/<id>/ whose
 * config.toml has project_id "<dev id>-ci" and every port inside portBase..portBase+9 (see ci-stack-config.mjs). Containers,
 * network and volumes are therefore fully separate from the dev stack's. Every CLI call is made with --workdir <that copy>, is
 * preceded by a re-read of the copy's project_id, and is refused if its argv could reach another project; every Docker object is
 * removed only after its project label is verified to be exactly the CI id.
 *
 *   up      lock (live owner never robbed) -> sweep orphans -> build the copy -> `supabase start` (stdout suppressed: it prints
 *           keys) -> strip restart policies (D052) -> `db reset` (one retry after the stack is healthy) -> record the environment.
 *           A failed up tears itself down.
 *   env     print the env vars the tests need (SUPABASE_URL, SUPABASE_ANON_KEY, ... see ci-stack-env.mjs) as `export` lines,
 *           for `eval "$(node ci-stack.mjs env)"`. SECRET-BEARING: callers must never print, log or `set -x` it.
 *           `--format json|dotenv` for other consumers.
 *   status  human summary (no keys). Exit 0 when the stack is up, 1 when not.
 *   down    `supabase stop --no-backup` for the CI project only, remove its labelled containers/volumes/networks and the workdir,
 *           release the lock. Idempotent; always safe to run (callers run it from an EXIT trap).
 *
 * The lock owner is the CALLER (the gate run), not this short-lived process: `--owner-pid N` / $CI_STACK_OWNER_PID, default the
 * parent pid. Exit: 0 ok, 1 failed, 2 a guard refused (nothing was started or removed).
 * Stuck stack by hand: `node ci-stack.mjs down` (takes the lock; refuses while another live run owns it).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RefusalError, assertCiConfig, deriveCiConfig, readCiStackConfig } from "./ci-stack-config.mjs";
import { busyPorts, containerNames, dockerRun, dockerUsable, leftovers, removeProjectObjects, stripRestartPolicies } from "./ci-stack-docker.mjs";
import { ciEnvFromStatus, formatEnv, parseEnvOutput, stackEnvVars } from "./ci-stack-env.mjs";
import { lockHolder, releaseLock, takeLock } from "./ci-stack-lock.mjs";
import { mapleDir } from "./gate-state.mjs";

export { RefusalError };

const COPY_SKIP = new Set([".temp", ".branches", "node_modules", ".git"]);
export const skipsCopy = (name) => COPY_SKIP.has(name) || name.startsWith(".env");
const SCRUB_PREFIXES = ["SUPABASE_", "TEST_SUPABASE_", "TEST_PLATFORM_", "E2E_", "CI_SUPABASE_", "VITE_SUPABASE_", "NEXT_PUBLIC_SUPABASE_"];
const FORBIDDEN_FLAGS = ["--all", "--linked", "--db-url", "--project-ref", "--network-id"];
const tail = (text, n) => String(text ?? "").split(/\r?\n/).filter(Boolean).slice(-n).join("\n");
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function ciPaths(base, projectId) {
  const workdir = join(base, "ci-stack", projectId);
  return { workdir, projectDir: join(workdir, "supabase"), configPath: join(workdir, "supabase", "config.toml"), sentinel: join(workdir, ".ci-stack-workdir"), envCache: join(workdir, "ci-env.json"), lock: join(base, "ci-stack", `${projectId}.lock`) };
}

const samePath = (a, b) => {
  const norm = (p) => resolve(p).replace(/\\/g, "/");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/** The owner's shell may export SUPABASE_URL & co.: nothing that could point a child at another stack is passed down. */
export function scrubbedEnv(base) {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !SCRUB_PREFIXES.some((p) => k.toUpperCase().startsWith(p))));
}

/** Last line of defence on every CLI call: only ever this workdir, only ever this project id. */
export function assertSafeArgv(argv, workdir, projectId) {
  for (const flag of FORBIDDEN_FLAGS) {
    if (argv.some((a) => a === flag || a.startsWith(`${flag}=`))) throw new RefusalError(`refusing supabase argv containing ${flag}`);
  }
  const wd = argv.indexOf("--workdir");
  if (wd < 0 || !argv[wd + 1] || !samePath(argv[wd + 1], workdir)) throw new RefusalError(`refusing a supabase call without --workdir ${workdir}`);
  const pid = argv.indexOf("--project-id");
  if (pid >= 0 && argv[pid + 1] !== projectId) throw new RefusalError(`refusing --project-id ${argv[pid + 1]}`);
  if (argv.includes("--no-backup") && pid < 0) throw new RefusalError(`refusing --no-backup without --project-id ${projectId}`);
}

/**
 * The project's own CLI as [command, ...prefix args]: the node entry of its installed `supabase` package (no shell, so paths with
 * spaces are safe; the version the project pinned, not whatever is on PATH), else `supabase` on PATH. MAPLE_SUPABASE_BIN overrides.
 */
export function findSupabaseBin(root, env = process.env) {
  if (env.MAPLE_SUPABASE_BIN) return [env.MAPLE_SUPABASE_BIN];
  const entry = join(root, "node_modules", "supabase", "dist", "supabase.js");
  if (existsSync(entry)) return [process.execPath, entry];
  const exe = process.platform === "win32" ? "supabase.exe" : "supabase";
  const legacy = join(root, "node_modules", "supabase", "bin", exe);
  return [existsSync(legacy) ? legacy : "supabase"];
}

const spawnSupabase = (bin, argv, { cwd, env, timeout, stdout }) => {
  const [cmd, ...pre] = [bin].flat();
  return spawnSync(cmd, [...pre, ...argv], { cwd, env, timeout, encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", stdout === "ignore" ? "ignore" : "pipe", "pipe"] });
};

/** A CLI caller bound to the CI workdir: re-verifies the project id and the argv on EVERY call. */
export function makeCli({ paths, projectId, bin, run = spawnSupabase, env = process.env }) {
  return (args, opts = {}) => {
    assertCiConfig(readFileSync(paths.configPath, "utf8"), projectId);
    const argv = [...args, "--workdir", paths.workdir];
    assertSafeArgv(argv, paths.workdir, projectId);
    return run(bin, argv, { cwd: paths.workdir, env: scrubbedEnv(env), ...opts });
  };
}

function failure(label, r) {
  return new Error(`${label} failed (exit ${r.status ?? "none"}): ${(r.error ? r.error.message : tail(r.stderr, 15)) || "(no output)"}`);
}

function removePlainDir(dir) {
  if (!existsSync(dir)) return;
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new RefusalError(`refusing to delete ${dir}: not a plain directory`);
  rmSync(dir, { recursive: true, force: true });
}

function claimWorkdir(paths, projectId) {
  if (!existsSync(paths.workdir)) {
    mkdirSync(paths.workdir, { recursive: true });
    writeFileSync(paths.sentinel, `${projectId}\n`);
    return;
  }
  const marker = existsSync(paths.sentinel) ? readFileSync(paths.sentinel, "utf8").trim() : null;
  if (marker !== projectId) throw new RefusalError(`refusing to reuse ${paths.workdir}: it carries no ci-stack sentinel for ${projectId} (remove it by hand if it is yours)`);
}

/** (Re)build <workdir>/supabase from the repo's supabase/ with the derived config.toml. Idempotent. */
export function buildWorkdir({ sourceSupabaseDir, paths, derived }) {
  claimWorkdir(paths, derived.projectId);
  removePlainDir(paths.projectDir);
  cpSync(sourceSupabaseDir, paths.projectDir, { recursive: true, filter: (src) => !skipsCopy(basename(src)) && !lstatSync(src).isSymbolicLink() });
  writeFileSync(paths.configPath, derived.toml);
  assertCiConfig(readFileSync(paths.configPath, "utf8"), derived.projectId);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function stopProject(ctx) {
  const r = ctx.cli(["stop", "--no-backup", "--project-id", ctx.projectId], { timeout: 5 * 60_000, stdout: "ignore" });
  if (r.status !== 0) ctx.log(`warning: supabase stop ${ctx.projectId} exited ${r.status ?? "none"}: ${tail(r.stderr, 3)}`);
}

/** Tear down everything of the CI project (CLI stop, then label-verified removal) and report what is left. */
function teardown(ctx) {
  if (existsSync(ctx.paths.configPath)) stopProject(ctx);
  const res = removeProjectObjects(ctx.docker, ctx.projectId, ctx.log);
  return { ...res, left: leftovers(ctx.docker, ctx.projectId) };
}

function acquire(ctx) {
  const lock = takeLock(ctx.paths.lock, { pid: ctx.ownerPid, alive: ctx.alive });
  if (!lock.ok) throw new RefusalError(lock.reason);
  return lock;
}

function dbReset(ctx) {
  const reset = () => ctx.cli(["db", "reset"], { timeout: 15 * 60_000, stdout: "ignore" });
  let r = reset();
  if (r.status !== 0) {
    // A cold start can report up before the database accepts the reset: wait for status, then exactly one more reset
    // (stack setup, not a test - nothing the gate judges is retried).
    ctx.log("db reset failed right after start; waiting for the stack, then one more attempt...");
    for (let waited = 0; waited < 60 && ctx.cli(["status", "-o", "env"], { timeout: 120_000 }).status !== 0; waited += 5) ctx.sleep(5000);
    r = reset();
  }
  if (r.status !== 0) throw failure("supabase db reset", r);
}

async function bringUp(ctx) {
  const { derived, paths, cli, log, projectId } = ctx;
  if (!ctx.dockerWorks()) throw new Error("Docker is not usable (`docker info` fails)");
  buildWorkdir({ sourceSupabaseDir: join(ctx.root, "supabase"), paths, derived });
  rmSync(paths.envCache, { force: true });
  log(`project ${projectId}: api :${derived.ports.api}, db :${derived.ports.db}, block ${ctx.cfg.portBase}-${ctx.cfg.portBase + 9}`);
  const swept = teardown(ctx); // orphans of a crashed run: the dev stack is untouched, only this project's label is
  if (swept.removed) log(`swept ${swept.removed} orphaned ${projectId} object(s) from an earlier run`);
  const busy = await ctx.busyPorts(derived.ports.all);
  if (busy.length) {
    const hint = busy.some((b) => b.code === "EACCES") ? " (EACCES = inside a Windows excluded port range; see docs/docker.md for the owner-run netsh command)" : "";
    throw new Error(`CI port(s) ${busy.map((b) => `${b.port} (${b.code})`).join(", ")} cannot be used${hint}`);
  }
  log("starting the CI stack (fresh volume)...");
  const exclude = ctx.cfg.exclude.length ? ["-x", ctx.cfg.exclude.join(",")] : [];
  const start = cli(["start", ...exclude], { timeout: 20 * 60_000, stdout: "ignore" }); // stdout carries keys: never captured
  if (start.status !== 0) throw failure("supabase start", start);
  stripRestartPolicies(ctx.docker, projectId, log);
  dbReset(ctx);
  stripRestartPolicies(ctx.docker, projectId, log);
  const status = cli(["status", "-o", "env"], { timeout: 5 * 60_000 }); // captured in memory only
  if (status.status !== 0) throw failure("supabase status", status);
  const env = ciEnvFromStatus(parseEnvOutput(status.stdout), derived, paths.workdir);
  writeFileSync(paths.envCache, JSON.stringify(env));
  try { chmodSync(paths.envCache, 0o600); } catch { /* best effort on Windows */ }
  log(`up: ${containerNames(ctx.docker, projectId).join(", ") || "(no containers listed)"}`);
}

export async function cmdUp(ctx) {
  acquire(ctx);
  try {
    await bringUp(ctx);
    return 0;
  } catch (e) {
    ctx.log("up failed: tearing the CI stack down");
    try { teardown(ctx); } catch (t) { ctx.log(`warning: teardown after a failed up: ${t.message}`); }
    throw e;
  }
}

export function cmdDown(ctx) {
  acquire(ctx);
  let code = 0;
  try {
    const { left } = teardown(ctx);
    if (left.length) { ctx.log(`warning: ${ctx.projectId} object(s) still present: ${left.join(", ")}`); code = 1; }
    else ctx.log(`down: ${ctx.projectId} removed (containers, networks, volumes)`);
    if (existsSync(ctx.paths.sentinel) && readFileSync(ctx.paths.sentinel, "utf8").trim() === ctx.projectId) removePlainDir(ctx.paths.workdir);
  } finally {
    releaseLock(ctx.paths.lock, ctx.ownerPid);
  }
  return code;
}

function readEnvCache(ctx) {
  let env;
  try { env = JSON.parse(readFileSync(ctx.paths.envCache, "utf8")); } catch { throw new Error("the CI stack is not up (no recorded environment): run `up` first"); }
  if (env.projectId !== ctx.projectId || String(env.apiPort) !== String(ctx.derived.ports.api) || String(env.dbPort) !== String(ctx.derived.ports.db)) {
    throw new RefusalError("the recorded CI environment does not describe the CI project");
  }
  return env;
}

export function cmdEnv(ctx, argv = []) {
  const fmt = flag(argv, "--format") ?? "sh";
  process.stdout.write(formatEnv(stackEnvVars(readEnvCache(ctx)), fmt)); // secret-bearing: stdout only, never through ctx.log
  return 0;
}

export function cmdStatus(ctx) {
  const containers = containerNames(ctx.docker, ctx.projectId);
  const owner = lockHolder(ctx.paths.lock);
  const up = existsSync(ctx.paths.envCache) && containers.length > 0;
  ctx.log(`project ${ctx.projectId} (dev stack ${ctx.derived.sourceProjectId} is never touched)`);
  ctx.log(`ports ${ctx.cfg.portBase}-${ctx.cfg.portBase + 9}: api ${ctx.derived.ports.api}, db ${ctx.derived.ports.db}`);
  ctx.log(`workdir ${ctx.paths.workdir}`);
  ctx.log(`lock owner: ${owner ?? "none"}; containers: ${containers.length}${containers.length ? ` (${containers.join(", ")})` : ""}`);
  ctx.log(up ? "state: up" : "state: down");
  return up ? 0 : 1;
}

const COMMANDS = { up: cmdUp, down: cmdDown, env: cmdEnv, status: cmdStatus };

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function makeContext({ root = process.cwd(), env = process.env, argv = [], log = (m) => console.error(`ci-stack: ${m}`) } = {}) {
  const cfg = readCiStackConfig(root);
  if (!cfg) throw new RefusalError("maple.config.json has no ci.stack {portBase}: the isolated CI stack is not configured");
  const configToml = join(root, "supabase", "config.toml");
  if (!existsSync(configToml)) throw new RefusalError("no supabase/config.toml in this repo");
  const derived = deriveCiConfig(readFileSync(configToml, "utf8"), cfg);
  const paths = ciPaths(mapleDir(root), cfg.projectId);
  const owner = Number(flag(argv, "--owner-pid") ?? env.CI_STACK_OWNER_PID ?? process.ppid);
  const ctx = { root, env, log, cfg, derived, paths, projectId: cfg.projectId, ownerPid: owner, alive: undefined, docker: dockerRun, busyPorts, dockerWorks: dockerUsable, sleep: sleepSync };
  ctx.cli = makeCli({ paths, projectId: cfg.projectId, bin: findSupabaseBin(root, env), env });
  return ctx;
}

export async function main(argv, makeCtx = makeContext) {
  const [cmd, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, cmd ?? "")) {
    console.error(`usage: node ci-stack.mjs <${Object.keys(COMMANDS).join("|")}> [--owner-pid N] [--root DIR] [--format sh|json|dotenv]`);
    return 2;
  }
  try {
    return await COMMANDS[cmd](makeCtx({ root: resolve(flag(rest, "--root") ?? process.cwd()), argv: rest }), rest);
  } catch (e) {
    console.error(`ci-stack: ${e instanceof RefusalError ? "REFUSED: " : ""}${e.message}`);
    return e instanceof RefusalError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
