import assert from "node:assert/strict";
import { applyAllowlist, validateEntries } from "./allowlist.mjs";
import { validatePredeploy } from "./config.mjs";
import { applyDecisions, decisionIdsIn, summarizeDecisions, validateDecisions } from "./decisions.mjs";
import { parseOutput } from "./parsers.mjs";
import { authRejections, buildPlan, containerScript, dockerArgs, PREFLIGHT_EXIT } from "./livescan.mjs";
import { semgrepArgs } from "./catalog.mjs";
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
  assert.ok(!text.includes("ZAPSCAN_"), "no auth placeholder in the plan: ZAP does not expand env vars in replacer rules");
  assert.equal(envNames[0].ref, "Proj-Scan-Token");
  assert.ok(!/Proj-Scan-Token/.test(text), "credential name must not leak into the plan either");
  assert.ok(!plan.jobs.some((j) => j.type === "replacer"), "a replacer job (deleteAllRules) would wipe the -config auth rules");
  assert.ok(plan.jobs.some((j) => j.type === "report"));
});
// Regression (0.10.7): replacer rules with replacementString "${ZAPSCAN_H0}" were sent literally,
// so every authenticated target was scanned unauthenticated. Auth now goes through -config
// replacer.full_list(n).* options expanded by the container's shell from `docker run -e`.
t("auth headers: -config replacer rules expanded in-container; secrets never in argv", () => {
  const cfg = ls(); cfg.targets[0].headers.push({ name: "CF-Access-Client-Secret", credentialRef: "Proj-Scan-Secret" }); cfg.targets.push({ id: "pub", url: "https://p.example" });
  const { envNames } = buildPlan(cfg);
  const argv = dockerArgs({ runDirNative: "C:/run", image: "zap:img", ls: cfg, envNames });
  assert.deepEqual(argv.slice(0, 9), ["run", "--rm", "-v", "C:/run:/zap/wrk:rw", "-e", "ZAPSCAN_H0", "-e", "ZAPSCAN_H1", "zap:img"]);
  assert.deepEqual(argv.slice(9, 11), ["sh", "-c"]);
  assert.equal(argv.length, 12);
  const sh = argv[11];
  for (const [i, name] of [[0, "X-T"], [1, "CF-Access-Client-Secret"]]) {
    for (const kv of [`.enabled=true`, `.matchtype=REQ_HEADER`, `.matchstr=${name}`, `.regex=false`]) assert.ok(sh.includes(`-config 'replacer.full_list(${i})${kv}'`), kv);
    assert.ok(sh.includes(`-config "replacer.full_list(${i}).replacement=$ZAPSCAN_H${i}"`), "replacement must be shell-expanded (double quotes)");
  }
  assert.ok(!/'[^']*\$ZAPSCAN/.test(sh.replace(/"[^"]*"/g, "")), "a $ZAPSCAN ref inside single quotes would be sent literally");
  assert.match(sh, /exec zap\.sh -cmd .*-autorun \/zap\/wrk\/plan\.yaml$/);
  assert.ok(sh.indexOf("MAPLE_PREFLIGHT_FAILED") < sh.indexOf("exec zap.sh"), "preflight runs before the scan");
  assert.ok(sh.includes(`-H "X-T: $ZAPSCAN_H0" -H "CF-Access-Client-Secret: $ZAPSCAN_H1" 'https://a.example'`));
  assert.ok(!sh.includes("p.example"), "unauthenticated targets get no preflight");
  assert.ok(sh.includes(`exit ${PREFLIGHT_EXIT}`));
  assert.ok(!/Proj-Scan/.test(argv.join(" ")), "credential refs never reach docker");
  assert.equal(containerScript({ targets: [{ id: "o", url: "https://o.example" }] }, []).includes("-config"), false);
  assert.throws(() => buildPlan({ ...ls(), targets: [{ id: "x", url: "https://x", headers: [{ name: "A: b\"; rm", credentialRef: "r" }] }] }), /invalid header name/);
});
// Regression (0.10.9): replacer rules had no URL scope, so ZAP added the Access service-token
// headers to EVERY proxied request — including third-party fonts/CDNs/Turnstile/analytics the
// scanned pages load — leaking the token. Each rule is now scoped to its own target's origin.
t("auth headers: each replacer rule matches only its own target's origin, never a foreign one", () => {
  const cfg = ls();
  cfg.targets = [
    { id: "dash", url: "https://dash.easy-call.co.il/login", headers: [{ name: "CF-Access-Client-Id", credentialRef: "Proj-Dash-Id" }, { name: "CF-Access-Client-Secret", credentialRef: "Proj-Dash-Secret" }] },
    { id: "admin", url: "https://admin.easy-call.co.il", headers: [{ name: "CF-Access-Client-Id", credentialRef: "Proj-Admin-Id" }] },
    { id: "api", url: "http://api.example:8443/v1", headers: [{ name: "X-T", credentialRef: "Proj-Api" }] },
    { id: "pub", url: "https://easy-call.co.il" },
  ];
  const { envNames } = buildPlan(cfg);
  const sh = containerScript(cfg, envNames);
  // Read the url scope back out of the generated container script, as ZAP will receive it.
  const scopes = envNames.map((e, i) => {
    const m = sh.match(new RegExp(`-config 'replacer\\.full_list\\(${i}\\)\\.url=([^']*)'`));
    assert.ok(m, `rule ${i} (${e.target}:${e.name}) has no url scope — it would be sent to every host`);
    assert.ok(!m[1].includes(","), "ZAP list-splits -config values on commas");
    return { ...e, re: new RegExp(m[1]) };
  });
  assert.equal(scopes.length, 4);
  const own = { dash: ["https://dash.easy-call.co.il/", "https://dash.easy-call.co.il", "https://dash.easy-call.co.il/app/x?y=1", "https://dash.easy-call.co.il:443/a", "https://dash.easy-call.co.il?q"],
    admin: ["https://admin.easy-call.co.il/", "https://admin.easy-call.co.il/users#x"],
    api: ["http://api.example:8443/v1/x", "http://api.example:8443/"] };
  const foreign = ["https://fonts.googleapis.com/css2?family=Heebo", "https://fonts.gstatic.com/s/x.woff2", "https://challenges.cloudflare.com/turnstile/v0/api.js",
    "https://www.googletagmanager.com/gtag/js?id=G-1", "https://cdn.jsdelivr.net/npm/x", "https://easy-call.co.il/", "https://www.easy-call.co.il/",
    "http://dash.easy-call.co.il/", "https://dash.easy-call.co.il:8443/", "https://dash.easy-call.co.il.evil.example/", "https://dash.easy-call.co.il@evil.example/",
    "https://evil.example/?u=https://dash.easy-call.co.il/", "https://evil.example/https://admin.easy-call.co.il/", "https://dashXeasy-call.co.il/", "http://api.example/v1", "https://api.example:8443/v1"];
  const all = [...Object.values(own).flat(), ...foreign];
  for (const s of scopes) {
    for (const u of all) {
      const allowed = (own[s.target] || []).includes(u);
      assert.equal(s.re.test(u), allowed, `${s.target}:${s.name} ${allowed ? "must" : "must NOT"} be sent to ${u}`);
    }
  }
  assert.ok(!envNames.some((e) => e.target === "pub"), "a target without headers gets no rule");
});
t("auth rejection fails loudly: preflight 401/403/Access redirect/no response, or spider 401/403 on the target URL", () => {
  const cfg = ls(); cfg.targets.push({ id: "pub", url: "https://p.example" });
  const { envNames } = buildPlan(cfg);
  const ids = (log) => authRejections(log, cfg, envNames).map((f) => f.id + ":" + f.severity);
  assert.deepEqual(ids("MAPLE_PREFLIGHT app 200 \nJob spider requesting URL https://a.example\n"), []);
  for (const line of ["MAPLE_PREFLIGHT app 403 ", "MAPLE_PREFLIGHT app 401 ", "MAPLE_PREFLIGHT app 000 ", "MAPLE_PREFLIGHT app 302 https://team.cloudflareaccess.com/cdn-cgi/access/login"])
    assert.deepEqual(ids(line + "\nMAPLE_PREFLIGHT_FAILED\n"), ["auth-rejected:app:high"], line);
  assert.equal(authRejections("MAPLE_PREFLIGHT app 403 \r\nMAPLE_PREFLIGHT_FAILED\r\n", cfg, envNames)[0].message.includes("MAPLE_PREFLIGHT_FAILED"), false, "next line is not parsed as a redirect");
  assert.deepEqual(ids("MAPLE_PREFLIGHT app 302 https://a.example/home\n"), [], "an app redirect is not an auth failure");
  const spider = (u, c) => `Job spider error accessing URL ${u} status code returned : ${c} expected 200\n`;
  assert.deepEqual(ids(spider("https://a.example/", 403)), ["auth-rejected:app:high"]);
  assert.deepEqual(ids(spider("https://a.example", 401) + spider("https://a.example", 403)), ["auth-rejected:app:high"], "one finding per target");
  assert.deepEqual(ids(spider("https://a.example/admin", 403)), [], "a 403 on a sub-path is the app's business");
  assert.deepEqual(ids(spider("https://p.example/", 403) + "MAPLE_PREFLIGHT pub 403 \n"), [], "targets without auth headers are not judged here");
  assert.deepEqual(ids(spider("https://a.example/", 500)), []);
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

// ── decision-backed exceptions (D061) ───────────────────────────────────────
const dtoday = new Date("2026-10-01T12:00:00Z");
const dl = (entries) => ({ path: "predeploy-decisions.json", entries, problems: [], present: true, raw: "" });
const ledgerOk = { ids: new Set(["D160", "D93"]), file: "decisions.md", error: null };
const dgood = { scanner: "checkov", rule: "CKV_AWS_109", scope: "infra/aws/kms.tf#aws_kms_key.rec", decision: "D160", why: "key policy root statement must be kms:* so IAM can delegate", reviewed: "2026-09-20" };
const dval = (entries, extra = {}) => validateDecisions(dl(entries), { checkIds: ["checkov", "osv-scanner", "suppression-audit"], today: dtoday, ledger: ledgerOk, ...extra }).map((f) => f.id);
t("decision entry: valid passes", () => assert.deepEqual(dval([dgood]), []));
t("decision entry: id missing from the ledger fails; unreadable ledger fails closed", () => {
  assert.deepEqual(dval([{ ...dgood, decision: "D999" }]), ["decision-missing"]);
  assert.deepEqual(dval([dgood], { ledger: { ids: new Set(), file: "x", error: "decisions ledger not found" } }), ["decision-ledger-unreadable"]);
});
t("decision entry: review older than max age fails (configurable), future date invalid", () => {
  assert.deepEqual(dval([{ ...dgood, reviewed: "2026-03-01" }]), ["decision-review-overdue"]);
  assert.deepEqual(dval([{ ...dgood, reviewed: "2026-03-01" }], { maxAgeDays: 365 }), []);
  assert.deepEqual(dval([{ ...dgood, reviewed: "2027-01-01" }]), ["decision-invalid"]);
});
t("decision entry: optional expires - valid passes, past expires blocks, must be within reviewed + max age", () => {
  assert.deepEqual(dval([{ ...dgood, expires: "2026-10-18" }]), []);
  assert.deepEqual(dval([{ ...dgood, expires: "2026-09-30" }]), ["decision-expired"]);
  assert.deepEqual(dval([{ ...dgood, expires: "2026-10-01" }]), [], "the expiry day itself is still valid");
  assert.deepEqual(dval([{ ...dgood, expires: "2027-03-19" }]), [], "reviewed 2026-09-20 + 180 days = 2027-03-19 is the last valid day");
  assert.deepEqual(dval([{ ...dgood, expires: "2027-03-20" }]), ["decision-invalid"]);
  assert.deepEqual(dval([{ ...dgood, expires: "2026-09-19" }]), ["decision-invalid"]);
  assert.deepEqual(dval([{ ...dgood, expires: "soon" }]), ["decision-invalid"]);
});
t("decision entry: an expired entry excepts nothing (the finding blocks again) and is not also reported stale", () => {
  const f = { check: "checkov", id: "CKV_AWS_109", severity: "high", message: "m", location: "infra/aws/kms.tf:10", resource: "aws_kms_key.rec" };
  const live = applyDecisions([f], dl([{ ...dgood, expires: "2026-10-18" }]), { ranChecks: ["checkov"], today: dtoday });
  assert.equal(live.backed.length, 1);
  const dead = applyDecisions([f], dl([{ ...dgood, expires: "2026-09-30" }]), { ranChecks: ["checkov"], today: dtoday });
  assert.equal(dead.backed.length, 0); assert.equal(dead.blocking.length, 1); assert.equal(dead.stale.length, 0);
});
t("decision entry: wildcard / directory / traversal scopes rejected", () => {
  for (const scope of ["infra/**", "infra/*.tf", "infra/aws/", "../x.tf", "a.tf#", "a.tf#b#c", "infra/aws/k?.tf"]) assert.deepEqual(dval([{ ...dgood, scope }]), ["decision-invalid"], scope);
});
t("decision entry: why length, unknown scanner, bad id, duplicates, unknown keys all invalid", () => {
  assert.deepEqual(dval([{ ...dgood, why: "too short" }]), ["decision-invalid"]);
  assert.deepEqual(dval([{ ...dgood, why: "x".repeat(601) }]), ["decision-invalid"]);
  assert.deepEqual(dval([{ ...dgood, scanner: "nope" }]), ["decision-invalid"]);
  assert.deepEqual(dval([{ ...dgood, decision: "160" }]), ["decision-invalid"]);
  assert.deepEqual(dval([dgood, dgood]), ["decision-invalid"]);
  assert.deepEqual(dval([{ ...dgood, owner: "maayan" }]), ["decision-invalid"]);
});
const cf = (extra = {}) => ({ check: "checkov", id: "CKV_AWS_109", location: "infra/aws/kms.tf:12", resource: "aws_kms_key.rec", ...extra });
t("decision scope: exact file#resource; survives line drift; other resource/rule/file does not match", () => {
  const r = applyDecisions([cf(), cf({ location: "infra/aws/kms.tf:99" }), cf({ resource: "aws_kms_key.other" }), cf({ id: "CKV_AWS_1" }), cf({ location: "infra/aws/other.tf:1" })], dl([dgood]), { ranChecks: ["checkov"] });
  assert.equal(r.backed.length, 2); assert.equal(r.blocking.length, 3); assert.equal(r.stale.length, 0);
});
t("decision scope: path-only entry covers that one file only", () => {
  const e = { ...dgood, scope: "infra/aws/kms.tf" };
  const r = applyDecisions([cf(), cf({ resource: "aws_kms_key.other" }), cf({ location: "infra/aws/other.tf:1" })], dl([e]), { ranChecks: [] });
  assert.equal(r.backed.length, 2); assert.equal(r.blocking.length, 1);
});
t("decision scope: wildcard entries can never except anything", () => {
  const r = applyDecisions([cf()], dl([{ ...dgood, scope: "infra/**" }]), { ranChecks: [] });
  assert.equal(r.backed.length, 0);
});
t("decision entry matching nothing is stale only for checks that ran", () => {
  assert.equal(applyDecisions([], dl([dgood]), { ranChecks: ["checkov"] }).stale[0].id, "decision-stale");
  assert.equal(applyDecisions([], dl([dgood]), { ranChecks: ["semgrep"] }).stale.length, 0);
});
t("decision summary is a separate prominent NOT ZERO line that states the rule", () => {
  const r = applyDecisions([cf()], dl([dgood]), { ranChecks: [] });
  const s = summarizeDecisions(r.backed, dl([dgood]));
  assert.match(s.lines[0], /1 DECISION-BACKED EXCEPTION .*NOT ZERO/); assert.match(s.lines[1], /ESSENTIALS ONLY/); assert.equal(s.total, 1);
});
t("config: decisionsMaxAgeDays bounded, decisions path must differ from allowlist", () => {
  const c = base(); c.predeploy.decisionsMaxAgeDays = 400; assert.ok(validatePredeploy(c).some((x) => /decisionsMaxAgeDays/.test(x)));
  c.predeploy.decisionsMaxAgeDays = 90; assert.deepEqual(validatePredeploy(c), []);
  c.predeploy.decisions = "predeploy-allowlist.json"; assert.ok(validatePredeploy(c).some((x) => /must differ/.test(x)));
});
t("parsers carry the scanner's resource id (checkov, osv, trivy) and strip checkov's leading slash", () => {
  const ck = JSON.stringify({ results: { failed_checks: [{ check_id: "CKV_X", check_name: "n", resource: "aws_s3_bucket.b", file_path: "/main.tf", repo_file_path: "/infra/main.tf", file_line_range: [3, 9] }] } });
  const f = parseOutput("checkov-json", { reports: ["r"], readReport: () => ck })[0];
  assert.equal(f.resource, "aws_s3_bucket.b"); assert.equal(f.location, "infra/main.tf:3");
  const osv = JSON.stringify({ results: [{ source: { path: "package-lock.json" }, packages: [{ package: { name: "xlsx", version: "0.18.5" }, vulnerabilities: [{ id: "GHSA-1", summary: "s" }], groups: [] }] }] });
  assert.equal(parseOutput("osv-json", { reports: ["r"], readReport: () => osv })[0].resource, "xlsx@0.18.5");
  const tv = JSON.stringify({ Results: [{ Target: "infra/main.tf", Misconfigurations: [{ ID: "AWS-0001", Severity: "HIGH", Title: "t", CauseMetadata: { Resource: "aws_s3_bucket.b", StartLine: 4 } }] }] });
  assert.equal(parseOutput("trivy-json", { reports: ["r"], readReport: () => tv })[0].resource, "aws_s3_bucket.b");
});

t("ledger ids: heading and bullet definitions count, bare mentions do not", () => {
  const ids = decisionIdsIn("## D161 | 2026-10-01 | x\n- **D14 — Cloud split (2026-08-10):** body\n- **D37 (postgres) — pinned:** b\n**D9 — posture**\nsee D999 and **D998** inline\n");
  assert.deepEqual([...ids].sort(), ["D14", "D161", "D37", "D9"]);
});

const wide = { scanner: "checkov", rule: "perf:unused_index", scope: "*", maxSeverity: "info", decision: "D160", why: "advisory noise that depends on traffic, not on any one resource", reviewed: "2026-09-20" };
t("rule-wide scope: valid with maxSeverity; any other wildcard, or maxSeverity without '*', is invalid", () => {
  assert.deepEqual(dval([wide]), []);
  assert.deepEqual(dval([{ ...wide, maxSeverity: undefined }]), ["decision-invalid"]);
  assert.deepEqual(dval([{ ...wide, maxSeverity: "nope" }]), ["decision-invalid"]);
  assert.deepEqual(dval([{ ...dgood, maxSeverity: "info" }]), ["decision-invalid"]);
  assert.ok(dval([{ ...wide, scope: "infra/*" }]).every((i) => i === "decision-invalid"));
});
t("rule-wide scope covers every finding of that exact rule up to the ceiling; worse or other rules still block", () => {
  const f = (extra) => ({ check: "checkov", id: "perf:unused_index", severity: "info", location: "idx_" + Math.random(), ...extra });
  const r = applyDecisions([f(), f(), f({ severity: "high" }), f({ id: "other:rule" })], dl([wide]), { ranChecks: ["checkov"] });
  assert.equal(r.backed.length, 2); assert.equal(r.blocking.length, 2); assert.equal(r.backed[0].decisionBacked.scope, "*");
  assert.equal(applyDecisions([], dl([wide]), { ranChecks: ["checkov"] }).stale[0].id, "decision-stale", "goes stale when it matches nothing");
});

t("semgrep --timeout is opt-in, whole seconds only, and never touches the suppression flags", () => {
  const base = { configs: ["p/x"], exclude: ["dist"] }, P = { out: "/out", src: "." };
  assert.ok(!semgrepArgs(base, P).includes("--timeout"), "unset keeps semgrep's default");
  assert.ok(semgrepArgs({ ...base, timeout: 30 }, P).includes(" --timeout 30 "));
  for (const bad of [0, -1, 2.5, "30", "30; rm -rf /", null]) assert.ok(!semgrepArgs({ ...base, timeout: bad }, P).includes("--timeout"), String(bad));
  assert.ok(semgrepArgs({ ...base, timeout: 30 }, P).includes("--disable-nosem"));
});

console.log(`\n${n} unit tests passed`);
