// heavy-run.mjs end to end against a throwaway origin + clone: green stamps the fetched tip and pays gate debt, red/partial
// leave no stamp and a failure report, a live lock is never stolen, a dead one is reclaimed, and the temporary worktree
// is ALWAYS removed without ever following its node_modules junction into the main checkout (D012).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as heavyRun, releaseLock, removeWorktree, takeLock } from "./heavy-run.mjs";
import { mapleDir, readHeavyStamp, recordDebt, unpaidDebt } from "./gate-state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "gate-cli.mjs").replace(/\\/g, "/");
const base = realpathSync(mkdtempSync(join(tmpdir(), "heavy-run-")));
const origin = join(base, "origin.git");
const repo = join(base, "repo");
const run = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: "utf8" });
const g = (cwd, ...args) => { const r = run(cwd, "git", args); assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };

run(base, "git", ["init", "-q", "--bare", "-b", "main", origin]);
run(base, "git", ["init", "-q", "-b", "main", repo]);
for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"]]) g(repo, "config", k, v);
const setHeavy = (cmd) => writeFileSync(join(repo, "maple.config.json"), JSON.stringify({ project: { name: "t", slug: "t" }, repo: { devBranch: "main" }, ci: { tiers: { heavy: cmd } } }, null, 2));
const commit = (msg, file = "f.txt") => { writeFileSync(join(repo, file), msg); g(repo, "add", "-A"); g(repo, "commit", "-q", "-m", msg); g(repo, "push", "-q", "origin", "main"); return g(repo, "rev-parse", "HEAD"); };
writeFileSync(join(repo, ".gitignore"), ".worktrees/\nnode_modules/\n");
g(repo, "remote", "add", "origin", origin);
setHeavy(`node "${CLI}" stamp`); // what ci-local.sh heavy does on green
const first = commit("first");
// the main checkout's node_modules (the junction target the temp worktree gets - must survive its removal)
mkdirSync(join(repo, "node_modules"), { recursive: true });
writeFileSync(join(repo, "node_modules", "marker.txt"), "precious");

const common = realpathSync(join(repo, ".git"));
const reports = () => { const d = join(common, "maple", "heavy-runs"); return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(d, f), "utf8"))) : []; };
const quiet = async (argv) => { const out = []; const code = await heavyRun(["--root", repo, ...argv], (l) => out.push(l)); return { code, out: out.join("\n") }; };
const tempWorktrees = () => g(repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ") && /_heavy-/.test(l));
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

await t("green: stamps the fetched tip, pays older gate debt, removes the temp worktree, keeps the main node_modules", async () => {
  recordDebt(repo, { sha: first, step: "live", reason: "docker-unavailable", ref: "#T15" });
  const tip = commit("second");
  const r = await quiet([]);
  assert.equal(r.code, 0, r.out);
  assert.ok(readHeavyStamp(repo, tip), "heavy-pass stamp for the fetched tip");
  assert.equal(unpaidDebt(repo).length, 0, "the green run paid the debt of the commits it contains");
  assert.equal(tempWorktrees().length, 0, "temp worktree removed");
  assert.equal(readdirSync(join(repo, ".worktrees")).filter((f) => f.startsWith("_heavy-")).length, 0);
  assert.equal(readFileSync(join(repo, "node_modules", "marker.txt"), "utf8"), "precious", "D012: removal never follows the junction");
  const rep = reports().at(-1);
  assert.equal(rep.status, "green"); assert.equal(rep.sha, tip);
  assert.ok(existsSync(rep.log));
  assert.equal(existsSync(join(mapleDir(repo), "heavy-run.lock")), false, "lock released");
});

await t("an already-green tip is not run again (unless --force)", async () => {
  const before = reports().length;
  const r = await quiet([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /already has a green heavy stamp/);
  assert.equal(reports().length, before);
});

await t("red: non-zero exit -> no stamp, a failure report with the log tail, worktree still removed", async () => {
  setHeavy(`echo "step boom: RLS test failed"; exit 1`);
  const tip = commit("third");
  const r = await quiet([]);
  assert.equal(r.code, 1);
  assert.equal(readHeavyStamp(repo, tip), null);
  const rep = reports().at(-1);
  assert.equal(rep.status, "red"); assert.equal(rep.exit, 1);
  assert.match(rep.tail, /RLS test failed/);
  assert.match(r.out, /RED for/);
  assert.equal(tempWorktrees().length, 0);
  assert.equal(readFileSync(join(repo, "node_modules", "marker.txt"), "utf8"), "precious");
});

await t("partial: exit 0 without a stamp (a step was skipped) is NOT green", async () => {
  setHeavy(`echo "skipped live (MAPLE_GATE_SKIP honoured)"; exit 0`);
  const tip = commit("fourth");
  const r = await quiet([]);
  assert.equal(r.code, 1);
  assert.equal(readHeavyStamp(repo, tip), null);
  assert.equal(reports().at(-1).status, "partial");
});

await t("a lock held by a LIVE pid is never stolen: no second run starts", async () => {
  setHeavy(`node "${CLI}" stamp`);
  commit("fifth");
  const live = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  const lockDir = join(mapleDir(repo), "heavy-run.lock");
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "pid"), `${live.pid}\n`);
  const before = reports().length;
  const r = await quiet([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /already in progress/);
  assert.equal(reports().length, before, "nothing ran");
  assert.equal(readFileSync(join(lockDir, "pid"), "utf8").trim(), String(live.pid), "the live holder's lock is intact");
  live.kill();
  rmSync(lockDir, { recursive: true, force: true });
});

await t("a lock whose holder is dead is reclaimed", async () => {
  const lockDir = join(mapleDir(repo), "heavy-run.lock");
  mkdirSync(lockDir);
  writeFileSync(join(lockDir, "pid"), "999999\n");
  const lock = takeLock(repo);
  assert.equal(lock.ok, true);
  assert.equal(readFileSync(join(lockDir, "pid"), "utf8").trim(), String(process.pid));
  releaseLock(lock);
});

await t("a young pid-less lock is respected, an old one reclaimed", () => {
  const lockDir = join(mapleDir(repo), "heavy-run.lock");
  mkdirSync(lockDir);
  assert.equal(takeLock(repo, { graceSec: 3600 }).ok, false);
  const l = takeLock(repo, { graceSec: 0 });
  assert.equal(l.ok, true);
  releaseLock(l);
});

await t("removeWorktree refuses anything that is not a _heavy-* worktree under .worktrees", () => {
  assert.throws(() => removeWorktree(repo, repo), /refusing to remove/);
  assert.throws(() => removeWorktree(repo, join(repo, ".worktrees", "agent-session")), /refusing to remove/);
  assert.throws(() => removeWorktree(repo, join(base, "elsewhere", "_heavy-abc")), /refusing to remove/);
});

await t("--force re-runs a green tip", async () => {
  setHeavy(`node "${CLI}" stamp`);
  const before = reports().length;
  const r = await quiet(["--force"]);
  assert.equal(r.code, 0, r.out);
  assert.equal(reports().length, before + 1);
});

console.log(`\nall ${n} heavy-run tests passed`);
