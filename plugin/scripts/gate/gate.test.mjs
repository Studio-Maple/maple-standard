// D066 gate state: skip-reason validation + verification, the debt ledger (record / pay / verify), heavy stamps and
// the production-promotion requirement. Hermetic: throwaway git repos, injected docker/registry/port probes.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./gate-cli.mjs";
import { SKIP_REASONS, lastHeavyBase, readDebt, stackPorts, unbindablePorts, unpaidDebt, validateSkip, verifyPromotion, verifyReason } from "./gate-state.mjs";

const repo = mkdtempSync(join(tmpdir(), "gate-state-"));
const g = (...args) => { const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, args.join(" ") + r.stderr); return r.stdout.trim(); };
g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
const commit = (name) => { writeFileSync(join(repo, name), name); g("add", "-A"); g("commit", "-q", "-m", name); return g("rev-parse", "HEAD"); };
mkdirSync(join(repo, "supabase"), { recursive: true });
writeFileSync(join(repo, "supabase", "config.toml"), ["[api]", "port = 56321", "[db]", "port = 56322", "shadow_port = 56320", "# port = 1", ""].join(String.fromCharCode(10)));
const A = commit("a"), B = commit("b"), C = commit("c");

const quiet = { out: () => {}, err: () => {} };
const run = (argv, extra = {}) => main(argv, { root: repo, ...quiet, ...extra });
const dockerDown = { dockerWorks: () => false, listen: async () => null, registryReachable: async () => true };
const dockerUp = { dockerWorks: () => true, listen: async () => null, registryReachable: async () => true };
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

await t("validateSkip: only listed reasons, only their own steps", () => {
  assert.equal(validateSkip({ reason: "", step: "live" }).ok, false);
  assert.equal(validateSkip({ reason: "because", step: "live" }).ok, false);
  assert.equal(validateSkip({ reason: "1", step: "live" }).ok, false);
  assert.equal(validateSkip({ reason: "docker-unavailable", step: "live" }).ok, true);
  assert.equal(validateSkip({ reason: "docker-unavailable", step: "dep-freshness" }).ok, false);
  assert.equal(validateSkip({ reason: "registry-unreachable", step: "dep-freshness" }).ok, true);
  assert.equal(validateSkip({ reason: "registry-unreachable", step: "live" }).ok, false);
  assert.deepEqual(Object.keys(SKIP_REASONS).sort(), ["docker-unavailable", "registry-unreachable"]);
});

await t("skip with an unknown reason exits 2 and records nothing", async () => {
  assert.equal(await run(["skip", "--step", "live"], { env: { MAPLE_GATE_SKIP: "lazy" }, deps: dockerDown }), 2);
  assert.equal(await run(["skip", "--step", "live"], { env: {}, deps: dockerDown }), 2);
  assert.equal(readDebt(repo).debts.length, 0);
});

await t("skip docker-unavailable is refused while docker works and the ports bind", async () => {
  assert.equal(await run(["skip", "--step", "live"], { env: { MAPLE_GATE_SKIP: "docker-unavailable" }, deps: dockerUp }), 1);
  assert.equal(readDebt(repo).debts.length, 0);
});

await t("skip docker-unavailable is honoured when docker is down, and appends a full debt record", async () => {
  assert.equal(await run(["skip", "--step", "live", "--ref", "#T15", "--sha", B], { env: { MAPLE_GATE_SKIP: "docker-unavailable" }, deps: dockerDown }), 0);
  const { debts } = readDebt(repo);
  assert.equal(debts.length, 1);
  const d = debts[0];
  assert.deepEqual(Object.keys(d).sort(), ["at", "branch", "reason", "ref", "sha", "step", "who"]);
  assert.equal(d.sha, B); assert.equal(d.step, "live"); assert.equal(d.reason, "docker-unavailable"); assert.equal(d.ref, "#T15");
  assert.ok(!Number.isNaN(Date.parse(d.at)));
});

await t("skip docker-unavailable is also honoured when a stack port is unbindable (reserved range)", async () => {
  const deps = { dockerWorks: () => true, listen: async (p) => (p === 56321 ? "EACCES" : null) };
  const r = await verifyReason(repo, "docker-unavailable", deps);
  assert.equal(r.ok, true);
  assert.match(r.detail, /56321 \(EACCES\)/);
});

await t("deprecated SKIP_LIVE_GATE=1 maps to docker-unavailable and is verified the same way", async () => {
  assert.equal(await run(["skip", "--step", "live"], { env: { SKIP_LIVE_GATE: "1" }, deps: dockerUp }), 1);
  assert.equal(await run(["skip", "--step", "live"], { env: { SKIP_LIVE_GATE: "1" }, deps: dockerDown }), 0);
  assert.equal(readDebt(repo).debts.length, 2);
});

await t("skip registry-unreachable verifies the registry is really down", async () => {
  assert.equal(await run(["skip", "--step", "dep-freshness"], { env: { MAPLE_GATE_SKIP: "registry-unreachable" }, deps: dockerUp }), 1);
  assert.equal(await run(["skip", "--step", "dep-freshness"], { env: { MAPLE_GATE_SKIP: "registry-unreachable" }, deps: { registryReachable: async () => false } }), 0);
});

await t("a reason cannot skip another reason's step (exit 3: the step just runs); unknown reasons fail validate", async () => {
  assert.equal(await run(["skip", "--step", "dep-freshness"], { env: { MAPLE_GATE_SKIP: "docker-unavailable" }, deps: dockerDown }), 3);
  assert.equal(await run(["skip", "--step", "live"], { env: { MAPLE_GATE_SKIP: "registry-unreachable" }, deps: dockerDown }), 3);
  assert.equal(await run(["validate"], { env: { MAPLE_GATE_SKIP: "lazy" } }), 2);
  assert.equal(await run(["validate"], { env: { MAPLE_GATE_SKIP: "registry-unreachable" } }), 0);
  assert.equal(await run(["validate"], { env: {} }), 0);
});

await t("stackPorts reads every *port in supabase/config.toml; unbindablePorts reports codes", async () => {
  mkdirSync(join(repo, "supabase"), { recursive: true });
  writeFileSync(join(repo, "supabase", "config.toml"), '[api]\nport = 56321\n[db]\nport = 56322\nshadow_port = 56320\n# port = 1\n');
  assert.deepEqual(stackPorts(repo).sort(), [56320, 56321, 56322]);
  const bad = await unbindablePorts([1, 2], async (p) => (p === 2 ? "EADDRINUSE" : null));
  assert.deepEqual(bad, [{ port: 2, code: "EADDRINUSE" }]);
});

await t("debt is scoped to HEAD's history; it is unpaid until a heavy run on a containing commit", async () => {
  // debts so far: B (live, x2 incl. SKIP_LIVE_GATE), B? the second skip used HEAD=C
  const all = unpaidDebt(repo);
  assert.ok(all.length >= 3);
  assert.equal(unpaidDebt(repo, { head: A }).length, 0, "A predates every debt");
  assert.equal(unpaidDebt(repo, { head: B }).length, 1, "only the B debt is in B's history");
  assert.equal(unpaidDebt(repo, { head: C }).length, all.length);
  assert.equal(await run(["pay", "--heavy-sha", A]), 0);
  assert.equal(unpaidDebt(repo).length, all.length, "a heavy run on A contains none of them");
});

await t("promotion verify: needs a heavy stamp for the exact sha AND zero unpaid debt", async () => {
  assert.equal(verifyPromotion(repo, C).ok, false);
  assert.match(verifyPromotion(repo, C).reason, /no green heavy run/);
  assert.equal(await run(["stamp", "--sha", C, "--skipped", "1"]), 1, "a run with skips never stamps");
  assert.equal(verifyPromotion(repo, C).ok, false);
  assert.equal(await run(["stamp", "--sha", B]), 1, "stamp is bound to HEAD of the checkout");
  assert.equal(await run(["stamp", "--sha", C]), 0);
  // a successful stamp on C paid every debt contained in C
  assert.equal(unpaidDebt(repo).length, 0);
  assert.deepEqual(verifyPromotion(repo, C).ok, true);
  assert.equal(verifyPromotion(repo, B).ok, false, "the stamp is for C only");
  assert.equal(await run(["verify", "--sha", C]), 0);
  assert.equal(await run(["verify", "--sha", B]), 1);
});

await t("new debt after a stamp blocks promotion until the next green heavy run", async () => {
  assert.equal(await run(["record", "--sha", C, "--step", "live", "--reason", "docker-unavailable", "--ref", "#T15"]), 0);
  assert.equal(verifyPromotion(repo, C).ok, false);
  assert.match(verifyPromotion(repo, C).reason, /unpaid gate debt/);
  const D = commit("d");
  assert.equal(verifyPromotion(repo, D).ok, false);
  assert.equal(await run(["stamp", "--sha", D]), 0);
  assert.equal(verifyPromotion(repo, D).ok, true);
  assert.equal(lastHeavyBase(repo, D), D);
  assert.equal(lastHeavyBase(repo, commit("e")), D);
});

await t("stamp refuses a dirty tracked tree", async () => {
  writeFileSync(join(repo, "a"), "changed");
  assert.equal(await run(["stamp"]), 1);
  g("checkout", "--", "a");
});

console.log(`\nall ${n} gate-state tests passed`);
