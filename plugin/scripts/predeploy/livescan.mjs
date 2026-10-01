#!/usr/bin/env node
/**
 * livescan.mjs — the aggressive live ZAP scan (`predeploy-gate --live`).
 *
 * POLICY (docs/predeploy-gate.md "Live scan policy"): a FULL ACTIVE scan with
 * the full attack policy (every scanner, strength High, threshold Low)
 * against the LIVE deployment — every configured HTTP(S) target — because an
 * attacker will not be gentle. Zero findings of any severity, except entries
 * in the expiring allowlist. Exactly two guards, both configured in
 * maple.config.json `predeploy.liveScan`:
 *   1. no real customer credentials — auth is only ever a named scan/service
 *      token credentialRef (never inlined, never a customer login);
 *   2. no request that can place a real PSTN call — `callOriginationExcludes`
 *      path regexes are excluded from every target's context.
 *
 * STAMP MODEL: run AFTER a deploy. The result is recorded in
 * <state>/live-scans/. Until a clean record covers the latest deploy-ledger
 * entry, no new stamp can be issued and the deploy guard blocks the next
 * deploy ("deploy debt", state.mjs). Never run by the unattended gate, never
 * run against anything not listed in config.
 *
 * Needs Docker (ZAP does not start natively on this Windows host).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { applyAllowlist, allowlistCommitted, loadAllowlist, validateEntries } from "./allowlist.mjs";
import { normalize, validatePredeploy } from "./config.mjs";
import { credentialExists, getCredential } from "./credentials.mjs";
import { findProjectRoot, headSha, loadMapleConfig, nowIso, sevRank, sha256, canonicalJson, stateDir } from "./lib.mjs";
import { parseOutput } from "./parsers.mjs";
import { liveScans, readLedger } from "./state.mjs";
import { dockerPull, dockerImagePresent, dockerUsable, nativePath } from "./tools.mjs";

const stripCaret = (re) => re.replace(/^\^/, "");
const HOST_ANY = "https?://[^/]+";

/** Pure: build the ZAP Automation Framework plan (JSON is valid YAML). Secrets appear only as ${ENV} placeholders. */
export function buildPlan(ls) {
  const dur = ls.maxDurationMin || 60;
  const threads = ls.threads || 5;
  const callEx = (ls.callOriginationExcludes || []).map((re) => `${HOST_ANY}${stripCaret(re)}`);
  const headers = [];
  const envNames = [];
  const contexts = [];
  const jobs = [];
  ls.targets.forEach((t) => {
    const origin = t.url.replace(/^(https?:\/\/[^/]+).*$/, "$1");
    contexts.push({
      name: t.id,
      urls: [t.url],
      includePaths: [`^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/.*)?$`],
      excludePaths: [...callEx, ...(t.excludeRegexes || []), ...(ls.extraExcludes || [])],
    });
    (t.headers || []).forEach((h) => {
      const env = `ZAPSCAN_H${envNames.length}`;
      envNames.push({ env, ref: h.credentialRef });
      headers.push({ description: `${t.id}:${h.name}`, matchType: "req_header", matchString: h.name, matchRegex: false, replacementString: "${" + env + "}", initiators: [] });
    });
  });
  jobs.push({ type: "replacer", parameters: { deleteAllRules: true }, rules: headers });
  jobs.push({ type: "passiveScan-config", parameters: { scanOnlyInScope: true, maxAlertsPerRule: 0 } });
  ls.targets.forEach((t) => {
    jobs.push({ type: "spider", parameters: { context: t.id, maxDuration: Math.min(dur, 15), maxDepth: 10, threadCount: threads } });
    jobs.push({ type: "spiderAjax", parameters: { context: t.id, maxDuration: 5, browserId: "firefox-headless" } });
    if (t.openapi) jobs.push({ type: "openapi", parameters: { apiUrl: t.openapi, targetUrl: t.url, context: t.id } });
  });
  jobs.push({ type: "passiveScan-wait", parameters: { maxDuration: 10 } });
  ls.targets.forEach((t) => {
    jobs.push({
      type: "activeScan",
      parameters: { context: t.id, maxScanDurationInMins: dur, maxRuleDurationInMins: 0, threadPerHost: threads },
      policyDefinition: { defaultStrength: "High", defaultThreshold: "Low", rules: [] },
    });
  });
  jobs.push({ type: "passiveScan-wait", parameters: { maxDuration: 10 } });
  jobs.push({ type: "report", parameters: { template: "traditional-json", reportDir: "/zap/wrk", reportFile: "zap-report", reportTitle: "predeploy live scan" }, risks: ["info", "low", "medium", "high"], confidences: ["falsepositive", "low", "medium", "high", "confirmed"] });
  return { plan: { env: { contexts, parameters: { failOnError: false, failOnWarning: false, progressToStdout: true } }, jobs }, envNames };
}

export async function main(argv) {
  const args = { root: null, pull: false, json: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--pull") args.pull = true;
    else if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--dry-run") args.dryRun = true; // writes the plan, prints it, scans nothing
    else { console.error("unknown argument " + argv[i]); return 2; }
  }
  const root = findProjectRoot(args.root || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const cfg = root && loadMapleConfig(root);
  if (!cfg) { console.error("no maple.config.json"); return 2; }
  const problems = validatePredeploy(cfg);
  if (problems.length) { console.error("predeploy config invalid:\n  " + problems.join("\n  ")); return 2; }
  const pd = normalize(cfg);
  const ls = pd?.liveScan;
  if (!ls || ls.enabled === false) { console.error("predeploy.liveScan is not configured/enabled"); return 2; }

  const runDir = join(stateDir(root), "runs", "live-" + Date.now());
  mkdirSync(runDir, { recursive: true });
  const { plan, envNames } = buildPlan(ls);
  writeFileSync(join(runDir, "plan.yaml"), JSON.stringify(plan, null, 2));
  if (args.dryRun) { console.log(JSON.stringify(plan, null, 2)); console.log(`\n(dry run — plan written to ${join(runDir, "plan.yaml")}; no request was sent)`); return 0; }

  const missing = envNames.filter((e) => !credentialExists(e.ref));
  if (missing.length) { console.error("missing credential(s): " + missing.map((m) => m.ref).join(", ") + " — store them via the credential-manager skill"); return 2; }
  if (!dockerUsable().ok) { console.error("Docker daemon not reachable — ZAP runs in Docker"); return 2; }
  const image = ls.image || "ghcr.io/zaproxy/zaproxy:stable";
  if (!dockerImagePresent(image) && !(args.pull || process.env.PREDEPLOY_PULL === "1" ? dockerPull(image) : false)) { console.error(`ZAP image ${image} missing — re-run with --pull`); return 2; }

  const sha = headSha(root);
  const coversSeq = readLedger(root).reduce((m, e) => Math.max(m, e.seq || 0), 0);
  const env = { ...process.env };
  for (const e of envNames) env[e.env] = getCredential(e.ref) || "";
  const dargs = ["run", "--rm", "-v", `${nativePath(runDir)}:/zap/wrk:rw`, ...envNames.flatMap((e) => ["-e", e.env]), image, "zap.sh", "-cmd", "-autorun", "/zap/wrk/plan.yaml"];
  console.log(`live scan: ${ls.targets.length} target(s), FULL ACTIVE policy (strength High / threshold Low); excluded call-origination routes: ${(ls.callOriginationExcludes || []).length}`);
  const timeoutMs = (ls.targets.length * (ls.maxDurationMin || 60) + 90) * 60000;
  const r = spawnSync("docker", dargs, { env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024 });
  writeFileSync(join(runDir, "zap.log"), (r.stdout || "") + (r.stderr || ""));
  const reportFile = join(runDir, "zap-report.json");
  const findings = [];
  let reportText = existsSync(reportFile) ? readFileSync(reportFile, "utf8") : null;
  if (r.status !== 0 && !reportText) findings.push({ check: "live-scan", id: "zap-failed", severity: "high", message: `ZAP exited ${r.status} without a report (see ${join(runDir, "zap.log")})`, location: "" });
  if (reportText) {
    findings.push(...parseOutput("zap-json", { reports: ["r"], readReport: () => reportText }).map((f) => ({ ...f, check: "live-scan" })));
    const sites = (JSON.parse(reportText).site || []).map((s) => s["@name"]);
    for (const t of ls.targets) {
      const origin = t.url.replace(/^(https?:\/\/[^/]+).*$/, "$1");
      if (!sites.some((s) => s === origin || s.startsWith(origin))) findings.push({ check: "live-scan", id: `target-no-coverage:${t.id}`, severity: "high", message: `ZAP recorded no traffic for ${origin} — unreachable or fully excluded; a scan that saw nothing is not a clean scan`, location: origin });
    }
  }

  const al = loadAllowlist(root, pd.allowlist);
  const floor = sevRank(ls.minSeverity || pd.minSeverity);
  const kept = findings.filter((f) => sevRank(f.severity) >= floor);
  const { blocking, allowed } = applyAllowlist(kept, al, { ranChecks: [] });
  const structural = validateEntries(al, { checkIds: [...pd.checks.map((c) => c.id), "live-scan"], maxDays: pd.allowlistMaxDays });
  if (!allowlistCommitted(root, al)) structural.push({ check: "allowlist", id: "allowlist-uncommitted", severity: "high", message: "allowlist file is untracked or modified", location: al.path });
  const all = [...blocking, ...structural];
  const ts = nowIso();
  const record = {
    ts, sha, coversSeq, status: all.length ? "fail" : "pass", blocking: all.length, allowlisted: allowed.length,
    targets: ls.targets.map((t) => t.id), targetsHash: sha256(canonicalJson(ls)), image,
    findings: all.slice(0, 500),
  };
  const stamp = ts.replace(/[:.]/g, "-");
  const dir = join(stateDir(root), "live-scans");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(record, null, 2));
  if (existsSync(reportFile)) copyFileSync(reportFile, join(dir, `${stamp}-zap-report.json`));

  if (args.json) console.log(JSON.stringify(record, null, 2));
  else {
    for (const f of all.slice(0, 300)) console.log(`  [live-scan] ${f.id} ${f.location || ""} — ${String(f.message).split("\n")[0].slice(0, 150)}`);
    console.log(`\nLIVE SCAN ${record.status.toUpperCase()}: ${all.length} blocking, ${allowed.length} allowlisted. Record: ${join(dir, stamp + ".json")}`);
  }
  return all.length ? 1 : 0;
}

export { liveScans };

if (process.argv[1]?.endsWith("livescan.mjs")) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
}
