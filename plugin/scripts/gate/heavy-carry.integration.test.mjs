// Heavy stamp carry-over end to end, through the real CLIs as separate processes, in a throwaway repo shaped like
// Consuming project: a real heavy pass on the origin (gate-cli stamp, as ci-local's heavy tier writes it), a late data-only
// commit (an allowlist row + the semgrep timeout 1800 -> 3600), `gate-cli carry`, then the
// production checks (`gate-cli verify`, predeploy `verify.mjs`, the fast lane's "fully stamped"). Predeploy is never
// carried; a code change, a forged record and a widened carry config are all refused.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { heavyStampPath, readHeavyStamp, unpaidDebt } from "./gate-state.mjs";
import { configHash, normalize } from "../predeploy/config.mjs";
import { allowlistHash, loadAllowlist } from "../predeploy/allowlist.mjs";
import { decisionsHash, loadDecisions } from "../predeploy/decisions.mjs";
import { GATE_VERSION, loadMapleConfig } from "../predeploy/lib.mjs";
import { stampPath } from "../predeploy/state.mjs";
import { fullyStamped } from "../predeploy/fastlane.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE_CLI = join(HERE, "gate-cli.mjs");
const VERIFY = join(HERE, "..", "predeploy", "verify.mjs");
const repo = realpathSync(mkdtempSync(join(tmpdir(), "heavy-carry-int-")));
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: repo } });
const g = (...args) => { const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, args.join(" ") + r.stderr); return r.stdout.trim(); };
const put = (f, v) => { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), typeof v === "string" ? v : JSON.stringify(v, null, 2) + "\n"); };
const commit = (m) => { g("add", "-A"); g("commit", "-q", "-m", m); return g("rev-parse", "HEAD"); };
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false"); g("config", "core.autocrlf", "false");
const CFG = (semgrepTimeout = 1800, carry = {}) => ({
  project: { name: "t", slug: "t" },
  repo: { devBranch: "main" },
  ci: { tiers: { heavy: "node -e 0" } },
  gate: { heavyCarryOver: { enabled: true, paths: ["predeploy-allowlist.json", "predeploy-decisions.json", "maple.config.json"], configKeys: ["predeploy.checks[*].timeoutSec"], ...carry } },
  predeploy: {
    allowlist: "predeploy-allowlist.json",
    docker: { enabled: false },
    checks: [{ id: "ok", command: "node -e \"process.exit(0)\"", timeoutSec: 60 }, { id: "semgrep", command: "node -e \"process.exit(0)\"", timeoutSec: semgrepTimeout }],
  },
});
put(".gitignore", ".worktrees/\n");
put("maple.config.json", CFG());
put("predeploy-allowlist.json", { version: 1, entries: [] });
put("predeploy-decisions.json", { version: 1, entries: [] });
put("src/app.js", "export const x = 1;\n");
const O = commit("origin");

/** The stamp document run.mjs writes on a green predeploy gate, bound to this checkout (as attest.mjs does). */
function writePredeployStamp(sha) {
  const pd = normalize(loadMapleConfig(repo));
  const issuedAt = new Date().toISOString();
  const rec = {
    version: GATE_VERSION, status: "pass", sha, tree: g("rev-parse", `${sha}^{tree}`), issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + pd.stampTtlHours * 3600000).toISOString(),
    configHash: configHash(pd), allowlistHash: allowlistHash(loadAllowlist(repo, pd.allowlist)), decisionsHash: decisionsHash(loadDecisions(repo, pd.decisions)),
    checks: [], remote: [], by: "test", who: "test",
  };
  const target = stampPath(repo, sha);
  writeFileSync(target + ".tmp", JSON.stringify(rec, null, 2));
  renameSync(target + ".tmp", target);
}

await t("origin: a real green heavy run is recorded by the heavy tier's own gate-cli stamp", () => {
  const r = run(GATE_CLI, ["stamp"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readHeavyStamp(repo, O).via, undefined);
});

let H1;
await t("a data-only commit has no heavy pass until it is carried; carry writes the audited record", () => {
  put("predeploy-allowlist.json", { version: 1, entries: [{ check: "semgrep", id: "rule-x", reason: "test row", owner: "t", expires: "2099-01-01" }] });
  put("maple.config.json", CFG(3600));
  H1 = commit("chore(gate): allowlist row + semgrep timeout 1800 -> 3600");
  const before = run(GATE_CLI, ["verify"]);
  assert.equal(before.status, 1);
  assert.match(before.stderr, /no green heavy run for HEAD/);
  const c = run(GATE_CLI, ["carry"]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /heavy pass carried to .* from .*predeploy-allowlist\.json, maple\.config\.json:predeploy\.checks\[id=semgrep\]\.timeoutSec/);
  const rec = readHeavyStamp(repo, H1);
  assert.equal(rec.via, "carry"); assert.equal(rec.carriedFrom, O); assert.equal(rec.at, readHeavyStamp(repo, O).at);
  assert.deepEqual(rec.configKeys, ["predeploy.checks[id=semgrep].timeoutSec"]);
  const v = run(GATE_CLI, ["verify"]);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /OK: heavy pass carried from/);
});

await t("predeploy is NOT carried: verify.mjs refuses until HEAD has its own predeploy stamp, then passes", () => {
  const no = run(VERIFY, ["--root", repo, "--check"]);
  assert.equal(no.status, 1);
  assert.match(no.stdout + no.stderr, /no predeploy stamp for HEAD/);
  writePredeployStamp(H1);
  const yes = run(VERIFY, ["--root", repo, "--check"]);
  assert.equal(yes.status, 0, yes.stdout + yes.stderr);
  assert.equal(fullyStamped(repo, H1), true, "the fast lane counts a carry that re-verifies");
});

await t("a code change after the origin is never carried, and a copied record does not make it so", () => {
  put("src/app.js", "export const x = 2;\n");
  put("predeploy-decisions.json", { version: 1, entries: [] , note: "touch" });
  const H2 = commit("feat: code + ledger");
  const c = run(GATE_CLI, ["carry"]);
  assert.equal(c.status, 1);
  assert.match(c.stderr, /carry refused \(diff\).*src\/app\.js \(not in gate\.heavyCarryOver\.paths\)/);
  assert.equal(readHeavyStamp(repo, H2), null, "nothing written");
  copyFileSync(heavyStampPath(repo, H1), heavyStampPath(repo, H2));
  const rec = readHeavyStamp(repo, H2);
  writeFileSync(heavyStampPath(repo, H2), JSON.stringify({ ...rec, sha: H2 }));
  const v = run(GATE_CLI, ["verify"]);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /carried heavy pass is refused \(diff\)/);
  writePredeployStamp(H2);
  const vd = run(VERIFY, ["--root", repo, "--check"]);
  assert.equal(vd.status, 1, "a full predeploy pass does not rescue a forged carry");
  assert.match(vd.stdout + vd.stderr, /no green heavy run for HEAD/);
  assert.equal(fullyStamped(repo, H2), false);
});

await t("widening the carry rules is itself never carried; a real heavy run must contain it", () => {
  g("checkout", "-q", "-B", "widen", O);
  put("maple.config.json", CFG(1800, { paths: ["predeploy-allowlist.json", "predeploy-decisions.json", "maple.config.json", "dep-policy.json"] }));
  commit("widen carry paths");
  const c = run(GATE_CLI, ["carry"]);
  assert.equal(c.status, 1);
  assert.match(c.stderr, /carry-config-changed/);
});

await t("carry pays no gate debt and leaves the real heavy run owed for debt in between", () => {
  g("checkout", "-q", "-B", "debt", O);
  put("predeploy-allowlist.json", { version: 1, entries: [], n: 1 });
  const D = commit("ledger with debt");
  const rec = run(GATE_CLI, ["record", "--sha", D, "--step", "live", "--reason", "docker-unavailable"]);
  assert.equal(rec.status, 0, rec.stderr);
  const c = run(GATE_CLI, ["carry"]);
  assert.equal(c.status, 1);
  assert.match(c.stderr, /unpaid gate debt/);
  assert.equal(unpaidDebt(repo, { head: D }).length, 1);
});

console.log(`\n${n} heavy-carry integration tests passed`);
