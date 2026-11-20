// Heavy stamp carry-over (gate.heavyCarryOver): the pure rules (path allow-list, key matcher, structural config diff,
// raw-diff judging, config validation) and the git-backed eligibility proof, every refusal reason, in throwaway repos.
// No wall clock: times are only compared for equality.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./gate-cli.mjs";
import { heavyPassFor, heavyStampPath, lastHeavyBase, readHeavyStamp, recordDebt, unpaidDebt, verifyPromotion, writeHeavyStamp } from "./gate-state.mjs";
import { carryEligibility, verifyCarryRecord } from "./heavy-carry.mjs";
import { judgeConfigChange, judgeEntries, keyProblem, matchKey, parseKeyPattern, pathProblem, validateGate } from "./heavy-carry-rules.mjs";
import { validateConfig } from "../validate-config.mjs";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };
const refusedKeys = (before, after, keys) => judgeConfigChange(before, after, keys).refused.map((r) => r.key);

// ── pure rules ──────────────────────────────────────────────────────────────
await t("paths: only exact top-level .json data files", () => {
  for (const ok of ["predeploy-allowlist.json", "predeploy-decisions.json", "maple.config.json", "dep-health-policy.json"]) assert.equal(pathProblem(ok), null, ok);
  const bad = {
    "*.json": /glob/, "predeploy-*.json": /glob/, "ledger/{a,b}.json": /glob/, "src/data.json": /top-level/, "config/x.json": /top-level/,
    "../x.json": /`\.` or `\.\.`|top-level/, "./x.json": /`\.`|top-level/, "/abs.json": /absolute/, "C:/x.json": /absolute/, "a\\b.json": /backslash/,
    "src/index.ts": /top-level/, "run.mjs": /\.json/, "migration.sql": /\.json/, "README.md": /\.json/, "package.json": /tool manifest/,
    "package-lock.json": /tool manifest/, "tsconfig.json": /tool manifest/, "tsconfig.app.json": /tool manifest/, "deno.json": /tool manifest/,
    "vercel.json": /tool manifest/, "knip.json": /tool manifest/, "": /non-empty/, " x.json": /whitespace/,
  };
  for (const [p, re] of Object.entries(bad)) assert.match(String(pathProblem(p)), re, p);
});

await t("key patterns: grammar, built-in refusals config cannot lift", () => {
  assert.deepEqual(parseKeyPattern("predeploy.checks[*].timeoutSec"), [{ k: "predeploy" }, { k: "checks" }, { any: true }, { k: "timeoutSec" }]);
  assert.deepEqual(parseKeyPattern("predeploy.checks[id=semgrep].timeoutSec")[2], { id: "semgrep" });
  assert.deepEqual(parseKeyPattern("predeploy.checks[3].timeoutSec")[2], { i: 3 });
  for (const bad of ["", "predeploy.", ".x", "[*].x", "predeploy.checks[*]", "predeploy.checks[foo]", "predeploy.checks[*", "predeploy..x", "predeploy.checks[*]x", "predeploy.a b"]) {
    assert.throws(() => parseKeyPattern(bad), undefined, bad);
  }
  assert.equal(keyProblem(parseKeyPattern("predeploy.checks[*].timeoutSec")), null);
  assert.equal(keyProblem(parseKeyPattern("predeploy.remote.timeoutMin")), null);
  for (const p of ["ci.tiers.heavy", "gate.heavyCarryOver.paths", "quality.jevAudit.enabled", "hooks.writeGuard", "officeci.url", "predeploy.fastLane.allow",
    "predeploy.fastLane.deadlineHours", "predeploy.deployGuard.enabled", "predeploy.emergency.maxMinutes", "predeploy.allowlist", "predeploy.decisions",
    "predeploy.imageDebt.file", "predeploy.enabled", "predeploy.checks[*].command", "predeploy.checks[*].preset", "predeploy.checks[*].github", "predeploy.liveScan.enabled"]) {
    assert.ok(keyProblem(parseKeyPattern(p)), p);
  }
});

await t("matchKey: exact whole path, [*] any element, [id=] one element, never a prefix", () => {
  const P = parseKeyPattern;
  const semgrep = [{ k: "predeploy" }, { k: "checks" }, { id: "semgrep" }, { k: "timeoutSec" }];
  assert.equal(matchKey(P("predeploy.checks[*].timeoutSec"), semgrep), true);
  assert.equal(matchKey(P("predeploy.checks[id=semgrep].timeoutSec"), semgrep), true);
  assert.equal(matchKey(P("predeploy.checks[id=knip].timeoutSec"), semgrep), false);
  assert.equal(matchKey(P("predeploy.checks[0].timeoutSec"), semgrep), false);
  assert.equal(matchKey(P("predeploy.checks[*].timeoutSec"), [{ k: "predeploy" }, { k: "checks" }, { i: 0 }, { k: "timeoutSec" }]), true);
  assert.equal(matchKey(P("predeploy.checks[*].options"), [...semgrep.slice(0, 3), { k: "options" }, { k: "timeout" }]), false, "no prefix match");
  assert.equal(matchKey(P("predeploy.checks[*].timeoutSec"), semgrep.slice(0, 3)), false);
});

const CHECKS = () => ({ predeploy: { minSeverity: "info", remote: { timeoutMin: 45 }, checks: [{ id: "knip", command: "k", timeoutSec: 900 }, { id: "semgrep", preset: "semgrep", timeoutSec: 1800, options: { timeout: 30, configs: ["a", "b"] } }] }, ci: { tiers: { heavy: "h" } }, gate: { heavyCarryOver: { enabled: true, paths: ["maple.config.json"], configKeys: ["predeploy.checks[*].timeoutSec"] } } });

await t("config diff: a check timeout edit carries (semgrep 1800 -> 3600)", () => {
  const a = CHECKS(), b = CHECKS();
  b.predeploy.checks[1].timeoutSec = 3600;
  const j = judgeConfigChange(a, b, ["predeploy.checks[*].timeoutSec"]);
  assert.equal(j.ok, true, JSON.stringify(j.refused));
  assert.deepEqual(j.changed, ["predeploy.checks[id=semgrep].timeoutSec"]);
  assert.equal(judgeConfigChange(a, b, ["predeploy.checks[id=semgrep].timeoutSec"]).ok, true);
  assert.equal(judgeConfigChange(a, b, ["predeploy.checks[id=knip].timeoutSec"]).ok, false);
  const c = CHECKS(); delete c.predeploy.checks[0].timeoutSec;
  const d = CHECKS();
  assert.equal(judgeConfigChange(c, d, ["predeploy.checks[*].timeoutSec"]).ok, true, "adding a timeout to an existing check object");
});

await t("config diff: non-listed key, structural changes, type flips and protected blocks always refuse", () => {
  const keys = ["predeploy.checks[*].timeoutSec"];
  const base = CHECKS();
  const mut = (f) => { const x = CHECKS(); f(x); return x; };
  assert.deepEqual(refusedKeys(base, mut((x) => { x.predeploy.minSeverity = "high"; }), keys), ["predeploy.minSeverity"]);
  assert.deepEqual(refusedKeys(base, mut((x) => { x.predeploy.remote.timeoutMin = 90; }), keys), ["predeploy.remote.timeoutMin"]);
  assert.deepEqual(refusedKeys(base, mut((x) => { x.predeploy.checks[1].options.timeout = 60; }), keys), ["predeploy.checks[id=semgrep].options.timeout"]);
  assert.deepEqual(refusedKeys(base, mut((x) => { x.predeploy.checks.push({ id: "extra", timeoutSec: 5 }); }), keys), ["predeploy.checks"], "a new array element is structural");
  assert.deepEqual(refusedKeys(base, mut((x) => { x.predeploy.checks.reverse(); }), keys), ["predeploy.checks"], "reordering is structural");
  assert.deepEqual(refusedKeys(base, mut((x) => { x.predeploy.checks[1].timeoutSec = { s: 1 }; }), keys), ["predeploy.checks[id=semgrep].timeoutSec"], "scalar -> object");
  assert.deepEqual(refusedKeys(base, mut((x) => { x.predeploy.checks[1].command = "rm -rf ."; }), [...keys]), ["predeploy.checks[id=semgrep].command"]);
  assert.deepEqual(refusedKeys(base, mut((x) => { x.predeploy.checks[1].options.configs.push("c"); }), keys), ["predeploy.checks[id=semgrep].options.configs"]);
  assert.deepEqual(refusedKeys(base, mut((x) => { x.ci.tiers.heavy = "true"; }), keys), ["ci.tiers.heavy"]);
  assert.deepEqual(refusedKeys(base, mut((x) => { x.gate.heavyCarryOver.paths.push("x.json"); }), keys), ["gate.heavyCarryOver.paths"]);
  assert.deepEqual(refusedKeys(base, mut((x) => { x.predeploy.fastLane = { enabled: true }; }), keys), ["predeploy.fastLane"]);
  assert.deepEqual(refusedKeys(base, mut((x) => { x.quality = { jevAudit: { enabled: false } }; }), keys), ["quality"]);
  // a listed pattern never unlocks a denied key, even if a crafted config got past validation
  assert.equal(judgeConfigChange(base, mut((x) => { x.ci.tiers.heavy = "true"; }), ["ci.tiers.heavy"]).ok, false);
  assert.equal(judgeConfigChange(base, mut((x) => { x.predeploy.fastLane = { enabled: true }; }), ["predeploy.fastLane.enabled"]).ok, false);
  assert.equal(judgeConfigChange(base, CHECKS(), keys).ok, true, "no change is fine");
});

await t("raw diff: only in-place content edits of listed regular files", () => {
  const e = (status, path, oldMode = "100644", newMode = "100644") => ({ status, path, oldMode, newMode });
  const paths = ["allow.json", "maple.config.json"];
  assert.deepEqual(judgeEntries([e("M", "allow.json"), e("M", "maple.config.json")], paths), { ok: true, paths: ["allow.json", "maple.config.json"], refused: [] });
  const reason = (entry, list = paths) => judgeEntries([entry], list).refused[0]?.reason;
  assert.equal(reason(e("A", "allow.json", "000000")), "file added");
  assert.equal(reason(e("D", "allow.json", "100644", "000000")), "file deleted");
  assert.match(reason(e("R", "allow.json")), /rename/);
  assert.match(reason(e("C", "allow.json")), /rename\/copy/);
  assert.match(reason(e("T", "allow.json", "100644", "120000")), /symbolic link/);
  assert.match(reason(e("M", "allow.json", "100644", "100755")), /mode change/);
  assert.match(reason(e("M", "allow.json", "100755", "100755")), /not a regular non-executable/);
  assert.equal(reason(e("M", "allow.json", "120000", "120000")), "symbolic link");
  assert.equal(reason(e("M", "vendor", "160000", "160000")), "submodule change");
  assert.equal(reason(e("M", "src/app.ts")), "not in gate.heavyCarryOver.paths");
  assert.match(reason(e("M", "src/app.ts"), ["src/app.ts"]), /top-level/, "a hand-crafted config listing code is still refused");
});

await t("validateGate / validateConfig: shape, exact paths, keys, maple.config.json <-> configKeys", () => {
  assert.deepEqual(validateGate(undefined), []);
  assert.deepEqual(validateGate({ heavyCarryOver: { enabled: false } }), []);
  assert.deepEqual(validateGate({ heavyCarryOver: { enabled: true, paths: ["predeploy-allowlist.json", "maple.config.json"], configKeys: ["predeploy.checks[*].timeoutSec"] } }), []);
  const errs = (h) => validateGate({ heavyCarryOver: h }).join("\n");
  assert.match(errs({ enabled: "yes", paths: ["a.json"] }), /enabled: required boolean/);
  assert.match(errs({ enabled: true }), /paths: required non-empty/);
  assert.match(errs({ enabled: true, paths: ["src/*.json"] }), /paths\[0\].*glob/);
  assert.match(errs({ enabled: true, paths: ["a.json", "a.json"] }), /duplicate/);
  assert.match(errs({ enabled: true, paths: ["maple.config.json"] }), /configKeys: required non-empty/);
  assert.match(errs({ enabled: true, paths: ["a.json"], configKeys: ["predeploy.checks[*].timeoutSec"] }), /maple.config.json is not in paths/);
  assert.match(errs({ enabled: true, paths: ["maple.config.json"], configKeys: ["ci.tiers.heavy"] }), /only keys under `predeploy\.`/);
  assert.match(errs({ enabled: true, paths: ["maple.config.json"], configKeys: ["predeploy.fastLane.enabled"] }), /never carry-able/);
  assert.match(errs({ enabled: true, paths: ["a.json"], extra: 1 }), /heavyCarryOver.extra: unknown key/);
  assert.match(validateGate({ other: 1 }).join(), /gate.other: unknown key/);
  assert.match(validateConfig({ gate: { heavyCarryOver: { enabled: true, paths: ["../x.json"] } } }).join("\n"), /gate.heavyCarryOver.paths\[0\]/);
  assert.deepEqual(validateConfig({ gate: { heavyCarryOver: { enabled: false, paths: [] } } }).filter((e) => e.startsWith("gate")), []);
});

// ── eligibility in a real repo ──────────────────────────────────────────────
const repo = mkdtempSync(join(tmpdir(), "heavy-carry-"));
const g = (...args) => { const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, args.join(" ") + r.stderr); return r.stdout.trim(); };
g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false"); g("config", "core.autocrlf", "false");
const CFG = (over = {}) => ({ project: { name: "t", slug: "t" }, predeploy: { checks: [{ id: "semgrep", preset: "semgrep", timeoutSec: 1800 }] }, gate: { heavyCarryOver: { enabled: true, paths: ["allow.json", "maple.config.json"], configKeys: ["predeploy.checks[*].timeoutSec"] } }, ...over });
const put = (file, content) => writeFileSync(join(repo, file), typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
const commit = (msg, indexOnly = false) => { if (!indexOnly) g("add", "-A"); g("commit", "-q", "--allow-empty", "-m", msg); return g("rev-parse", "HEAD"); };
put("maple.config.json", CFG()); put("allow.json", { rows: [] }); put("app.js", "console.log(1)\n");
const O = commit("origin");
writeHeavyStamp(repo, O);
const originAt = readHeavyStamp(repo, O).at;
const elig = (sha, from) => carryEligibility(repo, sha, { readStamp: readHeavyStamp, ...(from !== undefined ? { from } : {}) });
const scenario = (name, fn, indexOnly = false) => { g("checkout", "-q", "-f", "-B", name, O); g("clean", "-qfd"); fn(); return commit(name, indexOnly); };
const quiet = { out: () => {}, err: () => {} };
const cli = async (argv) => { const out = [], err = []; const code = await main(argv, { root: repo, out: (l) => out.push(l), err: (l) => err.push(l) }); return { code, out: out.join("\n"), err: err.join("\n") }; };

await t("eligible: a ledger edit and a listed timeout edit carry from the real heavy run", () => {
  const H = scenario("ok", () => { put("allow.json", { rows: [{ id: "x" }] }); const c = CFG(); c.predeploy.checks[0].timeoutSec = 3600; put("maple.config.json", c); });
  const r = elig(H);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.from, O); assert.equal(r.originAt, originAt);
  assert.deepEqual(r.paths, ["allow.json", "maple.config.json"]);
  assert.deepEqual(r.configKeys, ["predeploy.checks[id=semgrep].timeoutSec"]);
});

await t("refused: feature off (HEAD's committed config), and the carry config changing", () => {
  g("checkout", "-q", "-B", "off", O);
  put("maple.config.json", CFG({ gate: { heavyCarryOver: { enabled: false } } }));
  assert.equal(elig(commit("off")).code, "disabled");
  const H = scenario("widen", () => { const c = CFG(); c.gate.heavyCarryOver.paths.push("more.json"); put("maple.config.json", c); });
  assert.equal(elig(H).code, "carry-config-changed");
  const N = scenario("nocfg", () => { unlinkSync(join(repo, "maple.config.json")); });
  assert.equal(elig(N).code, "disabled");
  const B = scenario("badjson", () => { put("maple.config.json", "{ not json"); });
  assert.equal(elig(B).code, "disabled");
  assert.match(elig(B).reason, /not valid JSON/);
});

await t("refused: code edit, added file, deleted file, rename, mode change, symlink, submodule", () => {
  const code = (name, fn, re) => { const H = scenario(name, fn, /^(mode|symlink|submodule|symlink-swap)$/.test(name)); const r = elig(H); assert.equal(r.code, "diff", name + ": " + r.reason); assert.match(r.reason, re, name); };
  code("code", () => put("app.js", "console.log(2)\n"), /app\.js \(not in gate\.heavyCarryOver\.paths\)/);
  code("added", () => put("new.json", {}), /new\.json \(file added\)/);
  code("deleted", () => unlinkSync(join(repo, "allow.json")), /allow\.json \(file deleted\)/);
  code("renamed", () => g("mv", "allow.json", "allow2.json"), /allow\.json \(file deleted\).*allow2\.json \(file added\)/);
  code("mode", () => { g("update-index", "--chmod=+x", "allow.json"); }, /mode change 100644 -> 100755/);
  const blob = g("hash-object", "-w", "--stdin", "--path", "x");
  code("symlink", () => { g("update-index", "--add", "--cacheinfo", `120000,${blob},link.json`); }, /link\.json \(symbolic link\)/);
  code("submodule", () => { g("update-index", "--add", "--cacheinfo", `160000,${O},vendor`); }, /vendor \(submodule change\)/);
  code("symlink-swap", () => { g("rm", "-q", "--cached", "allow.json"); g("update-index", "--add", "--cacheinfo", `120000,${blob},allow.json`); }, /allow\.json \(symbolic link\)/);
  g("reset", "-q", "--hard"); g("clean", "-qfd");
});

await t("refused: a non-listed maple.config.json key", () => {
  const H = scenario("key", () => { const c = CFG(); c.predeploy.minSeverity = "critical"; put("maple.config.json", c); });
  const r = elig(H);
  assert.equal(r.code, "config-keys");
  assert.match(r.reason, /predeploy\.minSeverity \(matches no gate\.heavyCarryOver\.configKeys pattern\)/);
  const C = scenario("cmd", () => { const c = CFG(); c.predeploy.checks[0].command = "true"; put("maple.config.json", c); });
  assert.match(elig(C).reason, /a `command` key changes what runs/);
});

await t("refused: origin not a first-parent ancestor, origin record invalid / missing", () => {
  const side = scenario("side", () => put("allow.json", { rows: ["side"] }));
  writeHeavyStamp(repo, side);
  const H = scenario("main2", () => put("allow.json", { rows: ["main"] }));
  assert.equal(elig(H, side).code, "not-first-parent", "unrelated branch");
  assert.equal(elig(H, "f".repeat(40)).code, "not-first-parent");
  assert.equal(elig(H, "HEAD").code, "not-first-parent", "only a full sha is accepted");
  // a merge: side is an ancestor of M but not on its first-parent chain
  g("checkout", "-q", "main2"); put("other.json", {}); commit("noise");
  g("merge", "-q", "--no-ff", "-m", "merge", "side", "-X", "ours");
  const M = g("rev-parse", "HEAD");
  assert.equal(elig(M, side).code, "not-first-parent", "reached only through a merged side branch");
  // origin record: missing, wrong sha, wrong tree
  const P = scenario("p", () => put("allow.json", { rows: ["p"] }));
  const keep = readHeavyStamp(repo, O);
  unlinkSync(heavyStampPath(repo, O));
  assert.equal(elig(P, O).code, "origin-invalid");
  assert.equal(elig(P).code, "no-origin");
  writeFileSync(heavyStampPath(repo, O), JSON.stringify({ ...keep, tree: "0".repeat(40) }));
  assert.equal(elig(P, O).code, "origin-invalid");
  writeFileSync(heavyStampPath(repo, O), JSON.stringify({ ...keep, sha: side }));
  assert.equal(elig(P, O).code, "origin-invalid");
  writeFileSync(heavyStampPath(repo, O), JSON.stringify(keep));
  assert.equal(elig(P, O).ok, true);
});

await t("carried-from-carried: always evaluated against the ORIGINAL real run; a carry is never an origin", async () => {
  g("checkout", "-q", "-B", "chain", O);
  put("allow.json", { rows: [1] });
  const C = commit("c");
  assert.equal((await cli(["carry"])).code, 0);
  assert.equal(readHeavyStamp(repo, C).carriedFrom, O);
  put("allow.json", { rows: [1, 2] });
  const D = commit("d");
  const r = await cli(["carry"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(readHeavyStamp(repo, D).carriedFrom, O, "skips the carry on C, stores the original");
  assert.equal(elig(D, C).code, "origin-is-carry");
  writeFileSync(heavyStampPath(repo, D), JSON.stringify({ ...readHeavyStamp(repo, D), carriedFrom: C }));
  assert.equal(heavyPassFor(repo, D).ok, false, "a hand-pointed chain is refused at check time");
  assert.match(verifyPromotion(repo, D).reason, /origin-is-carry/);
  // and the cumulative diff from the original still decides: a code edit between C and D poisons every later carry
  put("app.js", "console.log(3)\n");
  commit("code");
  put("allow.json", { rows: [3] });
  commit("e");
  const r2 = await cli(["carry"]);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /app\.js/);
});

await t("gate-cli carry: writes an auditable record, origin's time, pays no debt, is not a heavy run", async () => {
  g("checkout", "-q", "-B", "cli", O);
  put("allow.json", { rows: ["cli"] });
  const H = commit("cli");
  assert.equal((await cli(["carry", "--sha", O])).code, 2, "no --sha: carry targets HEAD");
  put("allow.json", { rows: ["dirty"] });
  assert.match((await cli(["carry"])).err, /tracked files differ/);
  g("checkout", "-q", "--", "allow.json");
  const check = await cli(["carry", "--check"]);
  assert.equal(check.code, 0, check.err);
  assert.equal(readHeavyStamp(repo, H), null, "--check writes nothing");
  const debt = recordDebt(repo, { sha: H, step: "live", reason: "docker-unavailable" });
  assert.match((await cli(["carry"])).err, /unpaid gate debt/);
  // the debt stays on H (only a real heavy run pays it); continue on a fresh debt-free commit
  assert.equal(unpaidDebt(repo, { head: H }).length, 1);
  g("checkout", "-q", "-B", "cli2", O);
  put("allow.json", { rows: ["cli2"] });
  const H2 = commit("cli2");
  const r = await cli(["carry"]);
  assert.equal(r.code, 0, r.err);
  const rec = readHeavyStamp(repo, H2);
  assert.equal(rec.via, "carry"); assert.equal(rec.carriedFrom, O); assert.equal(rec.sha, H2);
  assert.equal(rec.at, originAt, "age follows the original heavy run");
  assert.ok(rec.carriedAt && rec.who && rec.tree);
  assert.deepEqual(rec.paths, ["allow.json"]);
  assert.equal(verifyPromotion(repo, H2).ok, true, verifyPromotion(repo, H2).reason);
  assert.match(verifyPromotion(repo, H2).reason, /carried from/);
  assert.equal(lastHeavyBase(repo, H2), O, "a carry is never the heavy baseline");
  assert.equal(await main(["has-stamp"], { root: repo, ...quiet }), 1, "has-stamp: a carry is not a heavy RUN");
  assert.equal(unpaidDebt(repo, { head: H }).length, 1, "carry never pays debt");
  assert.ok(debt);
  writeHeavyStamp(repo, H2);
  assert.match((await cli(["carry"])).err, /already has a real green heavy run/);
});

await t("check time: the record's own claims are never trusted; feature off or origin gone -> refused", () => {
  // hand-written carry claiming an origin for a code change
  const H = scenario("forged", () => put("app.js", "evil\n"));
  writeFileSync(heavyStampPath(repo, H), JSON.stringify({ sha: H, tier: "heavy", via: "carry", carriedFrom: O, paths: ["allow.json"], at: originAt }));
  assert.equal(verifyPromotion(repo, H).ok, false);
  assert.match(verifyPromotion(repo, H).reason, /\(diff\)/);
  // valid carry that loses its basis
  const K = scenario("loses", () => put("allow.json", { rows: ["k"] }));
  writeFileSync(heavyStampPath(repo, K), JSON.stringify({ sha: K, tier: "heavy", via: "carry", carriedFrom: O, at: originAt }));
  assert.equal(heavyPassFor(repo, K).ok, true);
  const keep = readHeavyStamp(repo, O);
  unlinkSync(heavyStampPath(repo, O));
  assert.equal(heavyPassFor(repo, K).ok, false);
  writeFileSync(heavyStampPath(repo, O), JSON.stringify(keep));
  assert.equal(verifyCarryRecord(repo, K, { ...readHeavyStamp(repo, K), via: undefined }, { readStamp: readHeavyStamp }).ok, false);
  // a carry record on a commit whose committed config has the feature off
  g("checkout", "-q", "-B", "offrec", O);
  put("maple.config.json", CFG({ gate: { heavyCarryOver: { enabled: false } } }));
  const F = commit("offrec");
  writeFileSync(heavyStampPath(repo, F), JSON.stringify({ sha: F, tier: "heavy", via: "carry", carriedFrom: O, at: originAt }));
  assert.match(verifyPromotion(repo, F).reason, /\(disabled\)/);
});

console.log(`\n${n} heavy-carry tests passed`);
