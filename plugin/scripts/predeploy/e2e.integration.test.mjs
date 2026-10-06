// End-to-end: a throwaway git repo, the real gate runner, the real guard hook.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as runGate } from "./run.mjs";
import { appendLedger, readLedger, liveScanDebt, reportPath, stampPath } from "./state.mjs";
import { headSha, stateDir } from "./lib.mjs";
import { normalize } from "./config.mjs";
import { payDebt, readHeavyStamp, recordDebt, writeHeavyStamp } from "../gate/gate-state.mjs";

const HOOK = join(fileURLToPath(import.meta.url), "..", "..", "..", "hooks", "guard.mjs");
const repo = mkdtempSync(join(tmpdir(), "predeploy-e2e-"));
const sh = (args) => { const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, args.join(" ") + r.stderr); return r.stdout.trim(); };
sh(["init", "-q"]); sh(["config", "user.email", "t@t"]); sh(["config", "user.name", "t"]); sh(["config", "commit.gpgsign", "false"]);

const cfgOf = (checks, extra = {}) => ({
  project: { name: "t", slug: "t" },
  predeploy: { checks, deployGuard: { patterns: [{ id: "dep", regex: "(^|[\\s/\\\\])deploy\\.sh\\b" }] }, ...extra },
});
const commit = (cfg, files = {}) => {
  writeFileSync(join(repo, "maple.config.json"), JSON.stringify(cfg, null, 2));
  for (const [k, v] of Object.entries(files)) { mkdirSync(dirname(join(repo, k)), { recursive: true }); writeFileSync(join(repo, k), v); }
  sh(["add", "-A"]); sh(["commit", "-q", "-m", "c", "--allow-empty"]);
};
// D066: production promotion also needs a green heavy run for HEAD and zero unpaid gate debt. Every case below that
// is about the predeploy stamp itself gets a heavy stamp for the current HEAD automatically; the dedicated D066
// cases at the end switch that off.
let autoHeavy = true;
const hook = (command, tool = "Bash") => {
  if (autoHeavy) { const s = headSha(repo); if (s && !readHeavyStamp(repo, s)) writeHeavyStamp(repo, s); }
  return hookRaw(command, tool);
};
const hookRaw = (command, tool = "Bash") => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: repo }), encoding: "utf8" });
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const gate = (...a) => quiet(() => runGate(["--root", repo, ...a]));
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

const OK = { id: "ok", command: 'node -e "process.exit(0)"' };
commit(cfgOf([OK]));

await t("deploy is blocked with no stamp (exit 2), non-deploy untouched", () => {
  const r = hook("bash deploy.sh --prod");
  assert.equal(r.status, 2, r.stdout + r.stderr); assert.match(r.stderr, /no predeploy stamp/);
  assert.equal(hook("node --version").status, 0);
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

await t("D066: a valid predeploy stamp is not enough - HEAD needs a green heavy run, and zero unpaid gate debt", async () => {
  commit(cfgOf([OK]), { "d066.txt": "1" });
  assert.equal(await gate(), 0);
  autoHeavy = false;
  const sha = headSha(repo);
  let r = hook("bash deploy.sh");
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /no green heavy run for HEAD/);
  writeHeavyStamp(repo, sha);
  assert.equal(hook("bash deploy.sh").status, 0, "stamp + heavy run => allowed");
  recordDebt(repo, { sha, step: "live", reason: "docker-unavailable", ref: "#T15" });
  r = hook("bash deploy.sh");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unpaid gate debt/);
  assert.equal(payDebt(repo, sha).length, 1);
  assert.equal(hook("bash deploy.sh").status, 0, "a green heavy run paid the debt");
  autoHeavy = true;
});

await t("D066: a heavy stamp for an OLDER commit does not promote a newer HEAD", async () => {
  autoHeavy = false;
  commit(cfgOf([OK]), { "d066b.txt": "1" });
  assert.equal(await gate(), 0);
  assert.equal(hook("bash deploy.sh").status, 2, "the previous commit's heavy stamp must not count");
  autoHeavy = true;
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


// ── decision-backed exceptions + suppression-audit (D061) ───────────────────
const SUP = { id: "suppress", preset: "suppression-audit" };
const report = () => JSON.parse(readFileSync(reportPath(repo, headSha(repo)), "utf8"));
const blockingIds = () => report().blocking.map((f) => `${f.check}:${f.id}`);
const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
const LEDGER = "# Decisions\n\n## D161 | 2026-10-01 | Test exception decision\nbody\n";
const SUPP_FILES = {
  "docs/decisions.md": LEDGER,
  "src/a.ts": "// eslint-disable-next-line no-console\nconsole.log(1);\n",
  ".gitleaks.toml": "[allowlist]\npaths = ['x']\n",
  "knip.json": '{ "ignoreDependencies": ["left-pad"] }\n',
  "osv-scanner.toml": "[[IgnoredVulns]]\nid = 'GHSA-xxxx'\n",
};
const dEntry = (rule, scope, extra = {}) => ({ scanner: "suppress", rule, scope, decision: "D161", why: "test fixture: this suppression cannot be removed in the fixture", reviewed: daysAgo(10), ...extra });
const ALL_ENTRIES = [
  dEntry("suppression:eslint-disable", "src/a.ts"),
  dEntry("suppression-file:.gitleaks.toml", ".gitleaks.toml"),
  dEntry("suppression-file:knip.json", "knip.json"),
  dEntry("suppression-file:osv-scanner.toml", "osv-scanner.toml"),
];
const withDecisions = (entries) => ({ "predeploy-decisions.json": JSON.stringify({ version: 1, entries }) });

await t("suppression-audit flags eslint-disable, gitleaks allowlists, knip ignores and osv-scanner.toml", async () => {
  commit(cfgOf([SUP]), SUPP_FILES);
  assert.equal(await gate(), 1);
  const ids = blockingIds();
  for (const want of ["suppression:eslint-disable", "suppression-file:.gitleaks.toml", "suppression-file:knip.json", "suppression-file:osv-scanner.toml"]) assert.ok(ids.includes("suppress:" + want), want + " in " + ids);
});

await t("a gitleaks config that only extends the default ruleset is not a suppression", async () => {
  commit(cfgOf([SUP]), { ".gitleaks.toml": "[extend]\nuseDefault = true\n", "src/a.ts": "console.log(1);\n", "knip.json": "{}\n", "osv-scanner.toml": "" });
  sh(["rm", "-q", "osv-scanner.toml"]); sh(["commit", "-q", "-m", "rm"]);
  assert.equal(await gate(), 0);
});

await t("decision-backed entries (D### in the ledger) except suppressions, are counted separately, and the stamp records them", async () => {
  commit(cfgOf([SUP]), { ...SUPP_FILES, ...withDecisions(ALL_ENTRIES) });
  { const c = await gate(); assert.equal(c, 0, JSON.stringify(report().blocking)); }
  const r = report();
  assert.equal(r.status, "pass"); assert.equal(r.totals.decisionBacked, 4); assert.equal(r.totals.allowlisted, 0); assert.equal(r.totals.blocking, 0);
  assert.equal(r.decisionExceptions.total, 4); assert.equal(r.decisionExceptions.items.length, 4); assert.match(r.decisionExceptions.rule, /ESSENTIALS ONLY/);
  assert.equal(r.decisionExceptions.items.find((i) => i.scope === ".gitleaks.toml").decision, "D161");
  const stamp = JSON.parse(readFileSync(stampPath(repo, headSha(repo)), "utf8"));
  assert.equal(stamp.decisionBacked, 4); assert.equal(typeof stamp.decisionsHash, "string");
  assert.equal(hook("bash deploy.sh").status, 0);
});

await t("console report shows decision-backed exceptions as their own NOT ZERO line with the rule", async () => {
  const lines = [];
  const log = console.log; console.log = (...a) => lines.push(a.join(" "));
  try { await runGate(["--root", repo, "--check", "suppress"]); } finally { console.log = log; }
  const text = lines.join("\n");
  assert.match(text, /\*\*\* 4 DECISION-BACKED EXCEPTIONS .*NOT ZERO/); assert.match(text, /ESSENTIALS ONLY/); assert.match(text, /decision-backed: suppress\/suppression-file:knip\.json knip\.json -> D161/);
});

await t("decision id missing from the ledger fails the gate", async () => {
  commit(cfgOf([SUP]), withDecisions([...ALL_ENTRIES.slice(0, 3), dEntry("suppression-file:osv-scanner.toml", "osv-scanner.toml", { decision: "D999" })]));
  assert.equal(await gate(), 1);
  assert.ok(blockingIds().includes("decisions:decision-missing"));
});

await t("an entry reviewed longer ago than the max age fails (forces re-review); the age is configurable", async () => {
  commit(cfgOf([SUP]), withDecisions([...ALL_ENTRIES.slice(0, 3), dEntry("suppression-file:osv-scanner.toml", "osv-scanner.toml", { reviewed: daysAgo(181) })]));
  assert.equal(await gate(), 1);
  assert.ok(blockingIds().includes("decisions:decision-review-overdue"));
  commit(cfgOf([SUP], { decisionsMaxAgeDays: 200 }));
  assert.equal(await gate(), 0);
});

await t("a stale entry (scope matches nothing) fails the gate", async () => {
  commit(cfgOf([SUP]), withDecisions([...ALL_ENTRIES, dEntry("suppression:nosemgrep", "src/gone.ts")]));
  assert.equal(await gate(), 1);
  assert.ok(blockingIds().includes("decisions:decision-stale"));
});

await t("a wildcard scope fails and excepts nothing", async () => {
  commit(cfgOf([SUP]), withDecisions([dEntry("suppression:eslint-disable", "src/*.ts"), ...ALL_ENTRIES.slice(1)]));
  assert.equal(await gate(), 1);
  const ids = blockingIds();
  assert.ok(ids.includes("decisions:decision-invalid") && ids.includes("suppress:suppression:eslint-disable"));
});

await t("an uncommitted edit to the decisions file fails the gate; the hook asks the owner before editing it", async () => {
  commit(cfgOf([SUP]), withDecisions(ALL_ENTRIES));
  writeFileSync(join(repo, "predeploy-decisions.json"), JSON.stringify({ version: 1, entries: [] }));
  assert.equal(await gate("--allow-dirty"), 1);
  assert.ok(blockingIds().includes("decisions:decision-uncommitted"));
  sh(["checkout", "--", "predeploy-decisions.json"]);
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(repo, "predeploy-decisions.json") }, cwd: repo }), encoding: "utf8" });
  assert.equal(r.status, 0); const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, "ask"); assert.match(out.permissionDecisionReason, /PERMANENT.*Essentials only/);
});

await t("changing the decisions file after the gate invalidates the stamp (hash binding)", async () => {
  commit(cfgOf([SUP]), withDecisions(ALL_ENTRIES));
  assert.equal(await gate(), 0);
  assert.equal(hook("bash deploy.sh").status, 0);
  const st = JSON.parse(readFileSync(stampPath(repo, headSha(repo)), "utf8"));
  writeFileSync(stampPath(repo, headSha(repo)), JSON.stringify({ ...st, decisionsHash: "0".repeat(64) }));
  assert.equal(hook("bash deploy.sh").status, 2);
});


await t("a check that could not run neither confirms nor stales decision entries (its own failure is the finding)", async () => {
  commit(cfgOf([{ id: "ghost", command: "definitely-not-a-real-tool-xyz" }]), withDecisions([dEntry("anything", "x.ts", { scanner: "ghost" })]));
  assert.equal(await gate(), 1);
  const ids = blockingIds();
  assert.ok(ids.includes("ghost:tool-missing"), ids.join(","));
  assert.ok(!ids.includes("decisions:decision-stale"), "must not stale an entry for a check that did not run: " + ids.join(","));
});

await t("a decision entry past its expires blocks the gate (decision-expired) and no longer excepts its finding", async () => {
  commit(cfgOf([SUP]), withDecisions([...ALL_ENTRIES.slice(0, 3), dEntry("suppression-file:osv-scanner.toml", "osv-scanner.toml", { expires: daysAgo(1) })]));
  assert.equal(await gate(), 1);
  const ids = blockingIds();
  assert.ok(ids.includes("decisions:decision-expired") && ids.includes("suppress:suppression-file:osv-scanner.toml"), ids.join());
  commit(cfgOf([SUP]), withDecisions([...ALL_ENTRIES.slice(0, 3), dEntry("suppression-file:osv-scanner.toml", "osv-scanner.toml", { expires: inDays(5) })]));
  assert.equal(await gate(), 0);
  assert.equal(report().decisionExceptions.items.find((i) => i.scope === "osv-scanner.toml").expires, inDays(5));
});

console.log(`\n${n} e2e tests passed`);
rmSync(repo, { recursive: true, force: true });
