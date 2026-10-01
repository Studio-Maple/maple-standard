import assert from "node:assert/strict";
import { applyAllowlist, validateEntries } from "./allowlist.mjs";
import { validatePredeploy } from "./config.mjs";
import { parseOutput } from "./parsers.mjs";
import { buildPlan } from "./livescan.mjs";
import { matchDeploy, touchesGateState } from "../../hooks/predeploy-guard.mjs";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };

// ── parsers: a crashed scanner is never "clean" ─────────────────────────────
t("missing report is a finding", () => {
  const f = parseOutput("semgrep-json", { reports: ["semgrep.json"], readReport: () => null });
  assert.equal(f[0].id, "no-report");
});
t("garbage report is a finding", () => {
  assert.equal(parseOutput("trivy-json", { reports: ["x"], readReport: () => "nope" })[0].id, "unparseable-report");
});
t("semgrep info/warning/error all count", () => {
  const rep = JSON.stringify({ results: ["INFO", "WARNING", "ERROR"].map((s, i) => ({ check_id: "r" + i, path: "a.ts", start: { line: 1 }, extra: { severity: s, message: "m" } })), errors: [] });
  assert.equal(parseOutput("semgrep-json", { reports: ["x"], readReport: () => rep }).length, 3);
});
t("zap informational alerts count", () => {
  const rep = JSON.stringify({ site: [{ "@name": "https://x", alerts: [{ pluginid: "10096", name: "Timestamp", riskcode: "0", instances: [{ uri: "https://x/" }] }] }] });
  const f = parseOutput("zap-json", { reports: ["x"], readReport: () => rep });
  assert.equal(f.length, 1); assert.equal(f[0].severity, "info");
});
t("exit-code parser", () => {
  assert.equal(parseOutput("exit-code", { status: 0, stdout: "", stderr: "" }).length, 0);
  assert.equal(parseOutput("exit-code", { status: 2, stdout: "boom", stderr: "" }).length, 1);
});
t("unknown severity ranks high, not info", () => {
  const rep = JSON.stringify({ results: [{ check_id: "r", path: "a", start: {}, extra: { severity: "WEIRD", message: "" } }], errors: [] });
  assert.equal(parseOutput("semgrep-json", { reports: ["x"], readReport: () => rep })[0].severity, "high");
});

// ── allowlist ───────────────────────────────────────────────────────────────
const today = new Date("2026-10-01T12:00:00Z");
const al = (entries) => ({ path: "al.json", entries, problems: [], present: true, raw: "" });
const good = { check: "semgrep", id: "r1", reason: "false positive in generated code", owner: "maayan", expires: "2026-11-01" };
t("valid entry passes validation and excepts the finding", () => {
  assert.equal(validateEntries(al([good]), { checkIds: ["semgrep"], today }).length, 0);
  const r = applyAllowlist([{ check: "semgrep", id: "r1", location: "a.ts:1" }, { check: "semgrep", id: "r2" }], al([good]), { today, ranChecks: ["semgrep"] });
  assert.equal(r.blocking.length, 1); assert.equal(r.allowed.length, 1);
});
t("expired entry fails and no longer excepts", () => {
  const e = { ...good, expires: "2026-09-30" };
  assert.equal(validateEntries(al([e]), { checkIds: ["semgrep"], today })[0].id, "allowlist-expired");
  assert.equal(applyAllowlist([{ check: "semgrep", id: "r1" }], al([e]), { today, ranChecks: ["semgrep"] }).blocking.length, 1);
});
t("far-future expiry is rejected (no indefinite exceptions)", () => {
  assert.equal(validateEntries(al([{ ...good, expires: "2030-01-01" }]), { checkIds: ["semgrep"], today })[0].id, "allowlist-too-long");
});
t("missing owner/reason rejected; unknown check rejected", () => {
  const ids = validateEntries(al([{ check: "nope", id: "x", expires: "2026-11-01" }]), { checkIds: ["semgrep"], today }).map((f) => f.id);
  assert.ok(ids.every((i) => i === "allowlist-invalid") && ids.length >= 3);
});
t("unused entry is flagged only for checks that ran", () => {
  assert.equal(applyAllowlist([], al([good]), { today, ranChecks: ["semgrep"] }).unused.length, 1);
  assert.equal(applyAllowlist([], al([good]), { today, ranChecks: ["lint"] }).unused.length, 0);
});
t("location scopes an entry", () => {
  const e = { ...good, location: "vendor/" };
  assert.equal(applyAllowlist([{ check: "semgrep", id: "r1", location: "src/a.ts:3" }], al([e]), { today, ranChecks: [] }).blocking.length, 1);
});

// ── config validation ───────────────────────────────────────────────────────
const base = () => ({ project: { name: "x", slug: "x" }, predeploy: { checks: [{ id: "lint", command: "npm run lint" }] } });
t("minimal config is valid", () => assert.deepEqual(validatePredeploy(base()), []));
for (const bad of ["npm run x || true", "tool --exit-zero", "eslint . --max-warnings=5", "npm audit --audit-level=high", "tool --no-exit-code", "cmd; true"]) {
  t(`silent threshold rejected: ${bad}`, () => {
    const c = base(); c.predeploy.checks[0].command = bad;
    assert.ok(validatePredeploy(c).some((e) => /silent|allows warnings|raises|swallows|disables|ends in/.test(e)), bad);
  });
}
t("github check needs a written why and remote.workflow", () => {
  const c = base(); c.predeploy.checks.push({ id: "remote", github: "predeploy-remote.yml" });
  const e = validatePredeploy(c);
  assert.ok(e.some((x) => /why/.test(x)) && e.some((x) => /remote\.workflow/.test(x)));
});
t("deployGuard cannot be disabled", () => {
  const c = base(); c.predeploy.deployGuard = { enabled: false };
  assert.ok(validatePredeploy(c).some((x) => /not allowed/.test(x)));
});
const ls = () => ({ enabled: true, targets: [{ id: "app", url: "https://a.example", headers: [{ name: "X-T", credentialRef: "Proj-Scan-Token" }] }], callOriginationExcludes: ["/call/dial.*"], guards: { noRealCustomerCredentials: true, noPstnCalls: true } });
t("liveScan valid", () => { const c = base(); c.predeploy.liveScan = ls(); assert.deepEqual(validatePredeploy(c), []); });
t("liveScan requires both guards, call excludes, no inline secrets, no customer creds", () => {
  let c = base(); c.predeploy.liveScan = { ...ls(), guards: { noPstnCalls: true } }; assert.ok(validatePredeploy(c).length);
  c = base(); c.predeploy.liveScan = { ...ls(), callOriginationExcludes: [] }; assert.ok(validatePredeploy(c).some((x) => /callOriginationExcludes/.test(x)));
  c = base(); c.predeploy.liveScan = { ...ls(), callOriginationExcludes: [], noCallOriginationRoutes: true }; assert.deepEqual(validatePredeploy(c), []);
  c = base(); c.predeploy.liveScan = ls(); c.predeploy.liveScan.targets[0].headers = [{ name: "A", credentialRef: "x", value: "inline-secret" }]; assert.ok(validatePredeploy(c).some((x) => /never inlined/.test(x)));
  c = base(); c.predeploy.liveScan = ls(); c.predeploy.liveScan.targets[0].headers[0].credentialRef = "Proj-Customer-Login"; assert.ok(validatePredeploy(c).some((x) => /customer credential/.test(x)));
});

// ── live scan plan ──────────────────────────────────────────────────────────
t("plan: full attack policy, call routes excluded on every context, secrets only as placeholders", () => {
  const cfg = ls(); cfg.targets.push({ id: "api", url: "https://api.example:8443/v1" });
  const { plan, envNames } = buildPlan(cfg);
  const active = plan.jobs.filter((j) => j.type === "activeScan");
  assert.equal(active.length, 2);
  for (const j of active) { assert.equal(j.policyDefinition.defaultStrength, "High"); assert.equal(j.policyDefinition.defaultThreshold, "Low"); }
  for (const c of plan.env.contexts) assert.ok(c.excludePaths.some((p) => new RegExp("^" + p + "$").test("https://x.example:8443/call/dial-action?a=1")));
  const text = JSON.stringify(plan);
  assert.ok(text.includes("${ZAPSCAN_H0}")); assert.equal(envNames[0].ref, "Proj-Scan-Token");
  assert.ok(!/Proj-Scan-Token/.test(text), "credential name must not leak into the plan either");
  assert.ok(plan.jobs.some((j) => j.type === "report"));
});

// ── deploy matching ─────────────────────────────────────────────────────────
const pats = [{ id: "hd", regex: "hardening-deploy\\.ps1[^|;&\\n]*-Step\\s+(supabase|app|images|vm-compose|admin)\\b" }, { id: "wr", regex: "(^|\\s)wrangler\\s+pages\\s+deploy\\b" }, { id: "tf", regex: "(^|\\s)terraform\\s+apply\\b" }];
t("deploy commands match", () => {
  assert.equal(matchDeploy("powershell -File scripts/deploy/hardening-deploy.ps1 -Step app -Yes", pats).id, "hd");
  assert.equal(matchDeploy("cd x && npx wrangler pages deploy dist", pats).id, "wr");
  assert.equal(matchDeploy("terraform apply -auto-approve", pats).id, "tf");
});
t("read-only mentions and non-mutating steps do not match", () => {
  assert.equal(matchDeploy("git commit -m 'terraform apply notes'", pats), null);
  assert.equal(matchDeploy("grep -rn 'wrangler pages deploy' docs", pats), null);
  assert.equal(matchDeploy("echo terraform apply", pats), null);
  assert.equal(matchDeploy("powershell -File scripts/deploy/hardening-deploy.ps1 -Step preflight", pats), null);
  assert.equal(matchDeploy("terraform plan", pats), null);
});
t("gate state tampering is detected, reading it is not", () => {
  assert.ok(touchesGateState("echo {} > .git/maple/predeploy/stamps/abc.json"));
  assert.ok(touchesGateState("cp x C:/repo/.git/maple/predeploy/emergency.json"));
  assert.ok(!touchesGateState("cat .git/maple/predeploy/deploys.jsonl"));
  assert.ok(!touchesGateState("npm test"));
});

t("eslint-json: one finding per warning, keyed rule + repo-relative file", () => {
  const rep = JSON.stringify([{ filePath: "C:\\repo\\app\\src\\a.ts", messages: [{ ruleId: "x/rule", severity: 1, line: 3, message: "m" }] }]);
  const f = parseOutput("eslint-json", { reports: ["r"], readReport: () => rep, repoRoot: "C:/repo" });
  assert.equal(f[0].id, "x/rule"); assert.equal(f[0].location, "app/src/a.ts:3");
});
t("knip-json flattens files, exports and duplicates", () => {
  const out = JSON.stringify({ files: ["a.ts"], issues: [{ file: "b.ts", exports: [{ name: "foo", line: 1 }], duplicates: [[{ name: "x" }, { name: "y" }]] }] });
  const ids = parseOutput("knip-json", { stdout: out, status: 1, reports: [], readReport: () => null }).map((f) => f.id);
  assert.deepEqual(ids, ["knip:unused-file", "knip:exports:foo", "knip:duplicates:x|y"]);
});
t("docs-drift-text keys findings by check header", () => {
  const out = "── dead-hostname (1) ──\n  docs/a.md:4  bad host\n";
  const f = parseOutput("docs-drift-text", { stdout: out, status: 1, stderr: "", reports: [], readReport: () => null });
  assert.equal(f[0].id, "dead-hostname"); assert.equal(f[0].location, "docs/a.md:4");
});

console.log(`\n${n} unit tests passed`);
