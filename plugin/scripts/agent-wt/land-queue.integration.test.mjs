// D066 landing queue, end to end with real git: temp origin + clone, real agent worktrees, the real maple-land.sh run as
// concurrent processes, a scripted gate. Proves: FIFO batch order with ONE gate, a conflicting branch returned while the
// rest land, a red gate bisected to the breaking branch (the rest land), a lock held by a live pid never stolen, a dead
// owner's lock reclaimed, dead landers' entries dropped, --no-push never pushes.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAND = join(HERE, "maple-land.sh").replace(/\\/g, "/");
const posix = (p) => p.replace(/\\/g, "/");
const base = realpathSync(mkdtempSync(join(tmpdir(), "maple-queue-")));
const origin = join(base, "origin.git");
const repo = join(base, "repo");
const gateLog = join(base, "gate.log");
const gateScript = join(base, "gate.sh");

const run = (cwd, cmd, args, env = {}) => spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
const g = (cwd, ...args) => { const r = run(cwd, "git", args); assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };

// the gate: records the tip it ran on; red while bad.txt exists in the tree
writeFileSync(gateScript, `#!/usr/bin/env bash\ngit rev-parse HEAD >> "${posix(gateLog)}"\nif [ -f bad.txt ]; then echo "gate: bad.txt present" >&2; exit 1; fi\nexit 0\n`);
run(base, "git", ["init", "-q", "--bare", "-b", "main", origin]);
run(base, "git", ["init", "-q", "-b", "main", repo]);
for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"]]) g(repo, "config", k, v);
writeFileSync(join(repo, "maple.config.json"), JSON.stringify({
  project: { name: "t", slug: "t" },
  repo: { devBranch: "main", prodBranch: "main" },
  ci: { prePushTier: "gate", tiers: { gate: `bash "${posix(gateScript)}"` } },
}, null, 2));
writeFileSync(join(repo, "shared.txt"), "line1\nline2\nline3\n");
writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", "init");
g(repo, "remote", "add", "origin", origin); g(repo, "push", "-q", "origin", "main");
const common = realpathSync(join(repo, ".git"));
const lockDir = join(common, "maple-land.lock");
const queueDir = () => join(common, "maple", "land-queue", "origin--main");

const ENV = { MAPLE_LAND_POLL: "1", MAPLE_LAND_WAIT: "120", GIT_TERMINAL_PROMPT: "0" };
let seq = 0;
/** worktree + one commit on a new agent branch */
function branch(slug, files) {
  const dir = join(repo, ".worktrees", slug);
  g(repo, "worktree", "add", "-q", "-b", `agent/${slug}`, dir, "origin/main");
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  g(dir, "add", "-A"); g(dir, "commit", "-q", "-m", `${slug}: ${Object.keys(files).join(",")}`);
  return dir;
}
const ACTIVE = [];
/** start maple-land.sh in a worktree; resolves with {code, out} */
function land(dir, extraArgs = [], env = {}) {
  const p = spawn("bash", [LAND, ...extraArgs], { cwd: dir, env: { ...process.env, ...ENV, ...env } });
  let out = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  const done = new Promise((res) => p.on("close", (code) => res({ code, out })));
  const handle = { done, p, get out() { return out; } };
  ACTIVE.push(handle);
  return handle;
}
const until = async (fn, ms = 240000, what = "condition") => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 200)); } for (const [i, a] of ACTIVE.entries()) console.error(`--- lander #${i} output ---
${a.out}`); throw new Error("timed out waiting for " + what); };
const entries = () => (existsSync(join(queueDir(), "entries")) ? readdirSync(join(queueDir(), "entries")).filter((f) => !f.startsWith(".")) : []);
const gateRuns = () => (existsSync(gateLog) ? readFileSync(gateLog, "utf8").split("\n").filter(Boolean).length : 0);
const originLog = () => g(repo, "log", "--format=%s", "origin/main").split("\n").filter(Boolean);
const refreshOrigin = () => g(repo, "fetch", "-q", "origin");

/** a live bash pid (MSYS pids are what kill -0 in the scripts can see) */
function liveHolder() {
  const p = spawn("bash", ["-c", "echo $$; while :; do sleep 1; done"], { stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((res) => p.stdout.once("data", (d) => res({ pid: String(d).trim(), kill: () => { try { p.kill(); } catch { /* gone */ } spawnSync("bash", ["-c", `kill ${String(d).trim()} 2>/dev/null`]); } })));
}
const writeLock = (pid, epoch = Math.floor(Date.now() / 1000)) => { mkdirSync(lockDir, { recursive: true }); writeFileSync(join(lockDir, "meta"), `${pid}\n${epoch}\nholder\n`); };
const resetGate = () => rmSync(gateLog, { force: true });
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

await t("a batch lands in FIFO order with ONE gate on the combined tip", async () => {
  resetGate();
  const holder = await liveHolder();
  writeLock(holder.pid); // someone else owns the lock while A, B, C queue up
  const dirs = { a: branch("a", { "a.txt": "a" }), b: branch("b", { "b.txt": "b" }), c: branch("c", { "c.txt": "c" }) };
  const runs = {};
  for (const slug of ["a", "b", "c"]) {
    runs[slug] = land(dirs[slug]);
    await until(() => entries().some((e) => e.endsWith("-" + slug)), 240000, `entry ${slug}`);
  }
  holder.kill(); // owner dies -> its lock is stale (dead pid) -> one lander reclaims it and lands all three
  const res = await Promise.all(["a", "b", "c"].map((s) => runs[s].done));
  res.forEach((r, i) => assert.equal(r.code, 0, `lander ${"abc"[i]} failed:\n${r.out}`));
  refreshOrigin();
  assert.deepEqual(originLog().slice(0, 3), ["c: c.txt", "b: b.txt", "a: a.txt"], "FIFO order on the target");
  if (gateRuns() !== 1) for (const r of res) console.error("--- lander ---" + String.fromCharCode(10) + r.out);
  assert.equal(gateRuns(), 1, "one gate for the whole batch");
  assert.ok(existsSync(join(repo, ".worktrees", "a")) === false && existsSync(join(repo, ".worktrees", "c")) === false, "landed worktrees pruned");
  assert.equal(existsSync(join(repo, ".worktrees", "_land")), false, "integration worktree removed");
  assert.equal(existsSync(lockDir), false, "owner lock released");
  assert.equal(entries().length, 0, "queue empty");
  g(repo, "pull", "-q", "--ff-only", "origin", "main");
});

await t("a conflicting branch is returned to its owner while the others land (still one gate)", async () => {
  resetGate();
  const holder = await liveHolder(); writeLock(holder.pid);
  const dirs = {
    x: branch("x", { "shared.txt": "line1\nX WAS HERE\nline3\n" }),
    y: branch("y", { "shared.txt": "line1\nY WAS HERE\nline3\n" }),
    z: branch("z", { "z.txt": "z" }),
  };
  const runs = {};
  for (const slug of ["x", "y", "z"]) { runs[slug] = land(dirs[slug]); await until(() => entries().some((e) => e.endsWith("-" + slug)), 240000, `entry ${slug}`); }
  holder.kill();
  const [rx, ry, rz] = await Promise.all(["x", "y", "z"].map((s) => runs[s].done));
  assert.equal(rx.code, 0, rx.out); assert.equal(rz.code, 0, rz.out);
  assert.notEqual(ry.code, 0, "y must be returned");
  assert.match(ry.out, /NOT landed - rebase onto .* failed: conflicts in: shared\.txt/);
  assert.ok(existsSync(join(repo, ".worktrees", "y")), "the returned branch keeps its worktree");
  refreshOrigin();
  const log = originLog();
  assert.ok(log.includes("x: shared.txt") && log.includes("z: z.txt") && !log.includes("y: shared.txt"));
  assert.equal(gateRuns(), 1);
  g(repo, "pull", "-q", "--ff-only", "origin", "main");
  spawnSync("git", ["worktree", "remove", "--force", join(repo, ".worktrees", "y")], { cwd: repo });
  spawnSync("git", ["branch", "-D", "agent/y"], { cwd: repo });
});

await t("a red gate is bisected to the breaking branch: it is returned, the rest land", async () => {
  resetGate();
  const holder = await liveHolder(); writeLock(holder.pid);
  const dirs = { p: branch("p", { "p.txt": "p" }), q: branch("q", { "bad.txt": "bad" }), r: branch("r", { "r.txt": "r" }), s: branch("s", { "s.txt": "s" }) };
  const runs = {};
  for (const slug of ["p", "q", "r", "s"]) { runs[slug] = land(dirs[slug]); await until(() => entries().some((e) => e.endsWith("-" + slug)), 240000, `entry ${slug}`); }
  holder.kill();
  const res = Object.fromEntries(await Promise.all(["p", "q", "r", "s"].map(async (s) => [s, await runs[s].done])));
  for (const s of ["p", "r", "s"]) assert.equal(res[s].code, 0, `${s} should land:\n${res[s].out}`);
  assert.notEqual(res.q.code, 0);
  assert.match(res.q.out, /NOT landed - the gate went red when this branch joined the batch/);
  refreshOrigin();
  const log = originLog();
  assert.ok(log.includes("p: p.txt") && log.includes("r: r.txt") && log.includes("s: s.txt") && !log.some((l) => l.startsWith("q:")));
  // 1 red on the full batch + 2 bisect probes (first 2, first 1) + 1 green re-batch of the rest = 4
  assert.equal(gateRuns(), 4, "gate runs: " + readFileSync(gateLog, "utf8"));
  g(repo, "pull", "-q", "--ff-only", "origin", "main");
  spawnSync("git", ["worktree", "remove", "--force", join(repo, ".worktrees", "q")], { cwd: repo });
  spawnSync("git", ["branch", "-D", "agent/q"], { cwd: repo });
});

await t("a lock held by a LIVE pid is never stolen, however old: the lander gives up, the lock stays", async () => {
  const holder = await liveHolder();
  writeLock(holder.pid, Math.floor(Date.now() / 1000) - 5 * 3600);
  spawnSync("touch", ["-d", "5 hours ago", lockDir]);
  const dir = branch("w", { "w.txt": "w" });
  const r = await land(dir, [], { MAPLE_LAND_WAIT: "5" }).done;
  assert.notEqual(r.code, 0);
  assert.match(r.out, /gave up after \d+s waiting in the land queue/);
  assert.equal(readFileSync(join(lockDir, "meta"), "utf8").split("\n")[0], holder.pid, "the live holder's lock is untouched");
  assert.equal(entries().length, 0, "the giver-up removed its own queue entry");
  holder.kill();
  rmSync(lockDir, { recursive: true, force: true });
  // now free: the same branch lands normally
  const ok = await land(dir).done;
  assert.equal(ok.code, 0, ok.out);
  g(repo, "pull", "-q", "--ff-only", "origin", "main");
});

await t("an entry whose lander is dead is dropped, not landed", async () => {
  resetGate();
  mkdirSync(join(queueDir(), "entries"), { recursive: true });
  writeFileSync(join(queueDir(), "entries", "1-999999-ghost"), "slug=ghost\nbranch=agent/ghost\nwt=/nowhere\npid=999999\nat=0\n");
  const dir = branch("v", { "v.txt": "v" });
  const r = await land(dir).done;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /dropping queue entry '1-999999-ghost'/);
  assert.equal(entries().length, 0);
  g(repo, "pull", "-q", "--ff-only", "origin", "main");
});

await t("--no-push rebases and gates this branch alone and pushes nothing", async () => {
  resetGate();
  refreshOrigin();
  const before = g(repo, "rev-parse", "origin/main");
  const dir = branch("np", { "np.txt": "np" });
  const r = await land(dir, ["--no-push"]).done;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /--no-push: rebased \+ gated but NOT pushed/);
  refreshOrigin();
  assert.equal(g(repo, "rev-parse", "origin/main"), before);
  assert.ok(existsSync(dir), "worktree left in place");
  assert.equal(gateRuns(), 1);
});

try { run(repo, "git", ["worktree", "prune"]); } catch { /* best effort */ }
console.log(`\nall ${n} land-queue tests passed`);
