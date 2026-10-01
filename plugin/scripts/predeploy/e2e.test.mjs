// End-to-end: a throwaway git repo, the real gate runner, the real guard hook.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as runGate } from "./run.mjs";
import { appendLedger, readLedger, liveScanDebt, stampPath } from "./state.mjs";
import { headSha, stateDir } from "./lib.mjs";
import { normalize } from "./config.mjs";

const HOOK = join(fileURLToPath(import.meta.url), "..", "..", "..", "hooks", "predeploy-guard.mjs");
const repo = mkdtempSync(join(tmpdir(), "predeploy-e2e-"));
const sh = (args) => { const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, args.join(" ") + r.stderr); return r.stdout.trim(); };
sh(["init", "-q"]); sh(["config", "user.email", "t@t"]); sh(["config", "user.name", "t"]); sh(["config", "commit.gpgsign", "false"]);

const cfgOf = (checks, extra = {}) => ({
  project: { name: "t", slug: "t" },
  predeploy: { checks, deployGuard: { patterns: [{ id: "dep", regex: "(^|[\\s/\\\\])deploy\\.sh\\b" }] }, ...extra },
});
const commit = (cfg, files = {}) => {
  writeFileSync(join(repo, "maple.config.json"), JSON.stringify(cfg, null, 2));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(repo, k), v);
  sh(["add", "-A"]); sh(["commit", "-q", "-m", "c", "--allow-empty"]);
};
const hook = (command, tool = "Bash") => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: repo }), encoding: "utf8" });
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const gate = (...a) => quiet(() => runGate(["--root", repo, ...a]));
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

const OK = { id: "ok", command: 'node -e "process.exit(0)"' };
commit(cfgOf([OK]));

await t("deploy is blocked with no stamp (exit 2), non-deploy untouched", () => {
  const r = hook("bash deploy.sh --prod");
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /no predeploy stamp/);
  assert.equal(hook("npm test").status, 0);
  assert.equal(hook("ls deploy.sh", "PowerShell").status, 0);
  assert.equal(hook("./deploy.sh", "PowerShell").status, 2);
});

await t("clean gate issues a stamp bound to sha; deploy then allowed and ledgered", async () => {
  assert.equal(await gate(), 0);
  const sha = headSha(repo);
  assert.ok(existsSync(stampPath(repo, sha)));
  assert.equal(hook("bash deploy.sh").status, 0);
  assert.equal(readLedger(repo).length, 1);
});

await t("a new commit invalidates the stamp", () => {
  commit(cfgOf([OK]), { "x.txt": "1" });
  assert.equal(hook("bash deploy.sh").status, 2);
});

await t("editing config after the gate invalidates it (config hash binding)", async () => {
  assert.equal(await gate(), 0);
  assert.equal(hook("bash deploy.sh").status, 0);
  writeFileSync(join(repo, "maple.config.json"), JSON.stringify(cfgOf([OK, { id: "extra", command: 'node -e "0"' }])));
  assert.equal(hook("bash deploy.sh").status, 2, "dirty tracked file");
  sh(["checkout", "--", "maple.config.json"]);
});

await t("failing check -> exit 1, no stamp", async () => {
  commit(cfgOf([{ id: "bad", command: 'node -e "process.exit(3)"' }]));
  assert.equal(await gate(), 1);
  assert.ok(!existsSync(stampPath(repo, headSha(repo))));
  assert.equal(hook("bash deploy.sh").status, 2);
});

await t("missing tool is a finding, never a skip", async () => {
  commit(cfgOf([{ id: "ghost", command: "definitely-not-a-real-tool-xyz" }]));
  assert.equal(await gate(), 1);
});

const WARN = { id: "lint", command: "node -e \"console.log('warning: x')\"", parse: "lines" };
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
await t("an exact, valid, committed allowlist entry excepts a finding", async () => {
  const entry = { check: "lint", id: "line", reason: "tool prints an informational line", owner: "maayan", expires: inDays(30) };
  commit(cfgOf([WARN]), { "predeploy-allowlist.json": JSON.stringify({ version: 1, entries: [entry] }) });
  assert.equal(await gate(), 0);
});

await t("expired allowlist entry fails the gate", async () => {
  const entry = { check: "lint", id: "line", reason: "tool prints an informational line", owner: "maayan", expires: "2020-01-01" };
  commit(cfgOf([WARN]), { "predeploy-allowlist.json": JSON.stringify({ version: 1, entries: [entry] }) });
  assert.equal(await gate(), 1);
});

await t("uncommitted allowlist edit fails the gate", async () => {
  const entry = { check: "lint", id: "line", reason: "tool prints an informational line", owner: "maayan", expires: inDays(30) };
  commit(cfgOf([WARN]), { "predeploy-allowlist.json": JSON.stringify({ version: 1, entries: [] }) });
  writeFileSync(join(repo, "predeploy-allowlist.json"), JSON.stringify({ version: 1, entries: [entry] }));
  assert.equal(await gate("--allow-dirty"), 1);
  sh(["checkout", "--", "predeploy-allowlist.json"]);
});

await t("gate state cannot be written by tool commands or Write/Edit", () => {
  assert.equal(hook("echo {} > .git/maple/predeploy/stamps/x.json").status, 2);
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(repo, ".git", "maple", "predeploy", "stamps", "x.json") }, cwd: repo }), encoding: "utf8" });
  assert.equal(r.status, 2);
});

await t("editing the allowlist asks the owner", () => {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(repo, "predeploy-allowlist.json") }, cwd: repo }), encoding: "utf8" });
  assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "ask");
});

await t("live-scan debt: no scan blocks; clean scan unblocks; a new deploy re-blocks; same-sha deploy steps do not", async () => {
  const live = { enabled: true, targets: [{ id: "app", url: "https://a.example" }], callOriginationExcludes: [], noCallOriginationRoutes: true, guards: { noRealCustomerCredentials: true, noPstnCalls: true } };
  commit(cfgOf([OK], { liveScan: live }), { "predeploy-allowlist.json": JSON.stringify({ version: 1, entries: [] }) });
  assert.equal(await gate(), 1, "no live scan ever recorded");
  const dir = join(stateDir(repo), "live-scans");
  mkdirSync(dir, { recursive: true });
  const seq = readLedger(repo).reduce((m, e) => Math.max(m, e.seq), 0);
  const rec = (status) => writeFileSync(join(dir, `${Date.now()}.json`), JSON.stringify({ ts: new Date().toISOString(), status, blocking: status === "pass" ? 0 : 1, coversSeq: seq }));
  rec("fail");
  assert.equal(await gate(), 1, "failed scan blocks");
  rec("pass");
  assert.equal(await gate(), 0, "clean scan covering all deploys unblocks");
  assert.equal(hook("bash deploy.sh").status, 0);
  assert.equal(hook("bash deploy.sh").status, 0, "second step of the same sha is not debt against its own stamp");
  const pd = normalize(JSON.parse(readFileSync(join(repo, "maple.config.json"), "utf8")));
  assert.equal(liveScanDebt(repo, pd).ok, false, "but a fresh stamp (no stamp context) sees the unscanned deploys");
  commit(cfgOf([OK], { liveScan: live }), { "y.txt": "1" });
  assert.equal(await gate(), 1, "new sha cannot be stamped until the live scan covers the last deploy");
});

console.log(`\n${n} e2e tests passed`);
rmSync(repo, { recursive: true, force: true });
