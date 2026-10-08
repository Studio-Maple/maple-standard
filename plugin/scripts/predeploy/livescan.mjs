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
 * REACHABILITY: every target is probed before Docker/ZAP starts (targetcheck.mjs). A parked/down target
 * (connection failure, Cloudflare 52x/530 error page, Access-only wall on an unauthenticated target) aborts
 * the scan with a blocking `target-down:<id>` record - never a pass, never findings about an error page.
 *
 * Needs Docker (ZAP does not start natively on this Windows host).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAllowlist, allowlistCommitted, loadAllowlist, validateEntries } from "./allowlist.mjs";
import { applyDecisions, decisionsCommitted, ledgerDecisionIds, loadDecisions, validateDecisions } from "./decisions.mjs";
import { normalize, validatePredeploy } from "./config.mjs";
import { credentialExists, getCredential } from "./credentials.mjs";
import { findProjectRoot, headSha, loadMapleConfig, nowIso, sevRank, sha256, canonicalJson, stateDir } from "./lib.mjs";
import { parseOutput } from "./parsers.mjs";
import { liveScans, readLedger } from "./state.mjs";
import { beginRun, finishRun, fmtGB, preflight } from "./runs.mjs";
import { checkTargets } from "./targetcheck.mjs";
import { dockerPull, dockerImagePresent, dockerUsable, nativePath } from "./tools.mjs";

const stripCaret = (re) => re.replace(/^\^/, "");
const HOST_ANY = "https?://[^/]+";
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
/** POSIX single-quote a literal for the container's sh. */
const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
/** Exit code the container script uses when an authenticated target rejects its credentials. */
export const PREFLIGHT_EXIT = 97;
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DEFAULT_PORT = { "http:": "80", "https:": "443" };

/**
 * Pure: the URL regex a target's auth-header replacer rule is scoped to — exactly that
 * target's scheme + host (+ port), any path. Without it ZAP's replacer adds the header to
 * EVERY request it proxies, including third-party fonts/CDNs/Turnstile/analytics the pages
 * reference, which leaks the service token to them. Anchored both ends, so it means the
 * same under Java's find() or matches(); "https://a.example.evil" and
 * "https://a.example@evil" do not match. No commas (ZAP -config values are list-split).
 */
export function originRegex(url) {
  const u = new URL(url);
  const port = u.port ? `:${u.port}` : `(?::${DEFAULT_PORT[u.protocol]})?`;
  return `^${reEscape(`${u.protocol}//${u.hostname}`)}${port}(?:[/?#].*)?$`;
}

/**
 * Pure: build the ZAP Automation Framework plan (JSON is valid YAML). The plan holds NO auth
 * header and no credential name: ZAP does not expand ${ENV} inside replacer rules (it sent
 * the literal "${ZAPSCAN_H0}", so every authenticated target was scanned unauthenticated).
 * Auth headers are injected as ZAP `-config replacer.full_list(n).*` options that the
 * container's shell expands from `docker run -e` variables (containerScript). The plan has
 * no replacer job, because one with deleteAllRules would wipe those rules. Each rule is
 * scoped to its own target's origin (originRegex), never global.
 */
export function buildPlan(ls) {
  const dur = ls.maxDurationMin || 60;
  const threads = ls.threads || 5;
  const callEx = (ls.callOriginationExcludes || []).map((re) => `${HOST_ANY}${stripCaret(re)}${re.endsWith("$") ? "" : ".*"}`);
  const envNames = [];
  const contexts = [];
  const jobs = [];
  ls.targets.forEach((t) => {
    const origin = t.url.replace(/^(https?:\/\/[^/]+).*$/, "$1");
    contexts.push({
      name: t.id,
      urls: [t.url],
      includePaths: [`^${reEscape(origin)}(/.*)?$`],
      excludePaths: [...callEx, ...(t.excludeRegexes || []), ...(ls.extraExcludes || [])],
    });
    (t.headers || []).forEach((h) => {
      if (!HEADER_NAME.test(h.name)) throw new Error(`liveScan target ${t.id}: invalid header name ${JSON.stringify(h.name)}`);
      envNames.push({ env: `ZAPSCAN_H${envNames.length}`, ref: h.credentialRef, target: t.id, name: h.name, urlRegex: originRegex(t.url) });
    });
  });
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

/**
 * Pure: the `sh -c` script run inside the ZAP container. Secrets are referenced only as
 * "$ZAPSCAN_Hn", expanded by the container's shell from `docker run -e ZAPSCAN_Hn` (value
 * inherited from the host process env), so they never appear in host argv, the plan or disk.
 * 1. Preflight: curl each authenticated target's URL with its headers; 401/403, a redirect
 *    to Cloudflare Access, or no response aborts with PREFLIGHT_EXIT before any scanning.
 * 2. exec zap.sh with one `replacer.full_list(n)` rule per header (ZAP's documented way
 *    to add auth headers), each limited by `.url` to its own target's origin, then the plan.
 */
export function containerScript(ls, envNames) {
  const out = ["fail=0"];
  for (const t of ls.targets) {
    const hs = envNames.filter((e) => e.target === t.id);
    if (!hs.length) continue;
    const hdr = hs.map((e) => `-H "${e.name}: $${e.env}"`).join(" ");
    out.push(`r=$(curl -s -o /dev/null --max-time 30 -w '%{http_code} %{redirect_url}' ${hdr} ${sq(t.url)} 2>/dev/null)`);
    out.push(`echo ${sq("MAPLE_PREFLIGHT " + t.id)} "$r"`);
    out.push(`case "$r" in 000*|401*|403*|3*cloudflareaccess.com*) fail=1;; esac`);
  }
  out.push(`if [ "$fail" != 0 ]; then echo MAPLE_PREFLIGHT_FAILED; exit ${PREFLIGHT_EXIT}; fi`);
  const cfg = [];
  envNames.forEach((e, i) => {
    const k = `replacer.full_list(${i})`;
    cfg.push(
      `-config ${sq(`${k}.description=${e.target}:${e.name}`)}`,
      `-config ${sq(`${k}.enabled=true`)}`,
      `-config ${sq(`${k}.url=${e.urlRegex}`)}`,
      `-config ${sq(`${k}.matchtype=REQ_HEADER`)}`,
      `-config ${sq(`${k}.matchstr=${e.name}`)}`,
      `-config ${sq(`${k}.regex=false`)}`,
      `-config "${k}.replacement=$${e.env}"`,
    );
  });
  out.push(["exec zap.sh -cmd", ...cfg, "-autorun /zap/wrk/plan.yaml"].join(" "));
  return out.join("\n");
}

/** Pure: the docker argv. Only env var NAMES are passed (`-e NAME`); values come from the spawn env. */
export function dockerArgs({ runDirNative, image, ls, envNames }) {
  return ["run", "--rm", "-v", `${runDirNative}:/zap/wrk:rw`, ...envNames.flatMap((e) => ["-e", e.env]), image, "sh", "-c", containerScript(ls, envNames)];
}

const trimSlash = (u) => u.replace(/\/+$/, "");

/**
 * Pure: blocking findings when an authenticated target was not actually authenticated —
 * a failed preflight line, or ZAP's spider reporting 401/403 on the target URL itself
 * ("Job spider error accessing URL <u> status code returned : 403 expected 200").
 * Such a scan tested the Access login wall, not the app; it must never pass or produce
 * findings that look like the app's.
 */
export function authRejections(log, ls, envNames) {
  const authed = new Map(ls.targets.filter((t) => envNames.some((e) => e.target === t.id)).map((t) => [t.id, t]));
  const out = [];
  const seen = new Set();
  const add = (t, why) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push({ check: "live-scan", id: `auth-rejected:${t.id}`, severity: "high", message: `target ${t.id} has auth headers configured but was not authenticated (${why}) — check the credential(s) and the Access policy; the scan did not test the app`, location: t.url });
  };
  for (const m of String(log).matchAll(/^MAPLE_PREFLIGHT (\S+) (\d{3})[ \t]*(\S*)[ \t]*\r?$/gm)) {
    const t = authed.get(m[1]);
    const code = m[2];
    if (t && (code === "000" || code === "401" || code === "403" || (code[0] === "3" && /cloudflareaccess\.com/.test(m[3])))) add(t, code === "000" ? "preflight: no response" : `preflight: HTTP ${code}${m[3] ? " -> " + m[3] : ""}`);
  }
  for (const m of String(log).matchAll(/error accessing URL (\S+) status code returned : (401|403)\b/g)) {
    for (const t of authed.values()) if (trimSlash(m[1]) === trimSlash(t.url)) add(t, `ZAP spider got HTTP ${m[2]} on the target URL`);
  }
  return out;
}

export async function main(argv) {
  const args = { root: null, pull: false, json: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--pull") args.pull = true;
    else if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--no-reach-check") { console.error("--no-reach-check does not exist: a scan of an unreachable target is never meaningful"); return 2; }
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

  if (!args.dryRun) {
    const pre = preflight(root, pd, { pruneCmd: `node "${join(dirname(fileURLToPath(import.meta.url)), "run.mjs")}" prune --all`, log: (m) => console.log(m) });
    if (!pre.ok) { console.error(pre.message); return 2; }
  }
  const run = beginRun(root, "live-" + Date.now());
  let code = 2;
  try {
    code = await scan({ args, root, pd, ls, runDir: run.dir, runName: run.name });
    return code;
  } finally {
    const done = finishRun(run, { kind: "live", exit: code });
    console.log(`run workspace pruned (${fmtGB(done.freedBytes)} freed): ${run.dir}`);
    for (const e of done.errors.slice(0, 5)) console.error(`could not remove: ${e}`);
  }
}

async function scan({ args, root, pd, ls, runDir, runName }) {
  const logFile = join(stateDir(root), "live-scans", `${runName}.zap.log`);
  const { plan, envNames } = buildPlan(ls);
  writeFileSync(join(runDir, "plan.yaml"), JSON.stringify(plan, null, 2));
  if (args.dryRun) { console.log(JSON.stringify(plan, null, 2)); console.log("\n# container script (secrets only as $ZAPSCAN_Hn, expanded inside the container):\n" + containerScript(ls, envNames)); console.log(`\n(dry run — plan printed above; no request was sent)`); return 0; }

  const reach = await checkTargets(ls, args.probe ? { probe: args.probe } : {});
  for (const r of reach.results) console.log(`  target ${r.id}: ${r.state === "up" ? "up" : r.state.toUpperCase()} (${r.reason})`);
  if (reach.findings.length) return recordTargetDown({ args, root, sha: headSha(root), coversSeq: readLedger(root).reduce((m, e) => Math.max(m, e.seq || 0), 0), ls, findings: reach.findings });

  const missing = envNames.filter((e) => !credentialExists(e.ref));
  if (missing.length) { console.error("missing credential(s): " + missing.map((m) => m.ref).join(", ") + " — store them via the credential-manager skill"); return 2; }
  if (!dockerUsable().ok) { console.error("Docker daemon not reachable — ZAP runs in Docker"); return 2; }
  const image = ls.image || "ghcr.io/zaproxy/zaproxy:stable";
  if (!dockerImagePresent(image) && !(args.pull || process.env.PREDEPLOY_PULL === "1" ? dockerPull(image) : false)) { console.error(`ZAP image ${image} missing — re-run with --pull`); return 2; }

  const sha = headSha(root);
  const coversSeq = readLedger(root).reduce((m, e) => Math.max(m, e.seq || 0), 0);
  const env = { ...process.env };
  for (const e of envNames) env[e.env] = getCredential(e.ref) || "";
  const dargs = dockerArgs({ runDirNative: nativePath(runDir), image, ls, envNames });
  console.log(`live scan: ${ls.targets.length} target(s), FULL ACTIVE policy (strength High / threshold Low); excluded call-origination routes: ${(ls.callOriginationExcludes || []).length}`);
  const timeoutMs = (ls.targets.length * (ls.maxDurationMin || 60) + 90) * 60000;
  const r = spawnSync("docker", dargs, { env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 512 * 1024 * 1024 });
  const log = (r.stdout || "") + (r.stderr || "");
  // The container log is the evidence for a failed scan; keep its tail with the live-scan records (the run workspace is deleted).
  mkdirSync(dirname(logFile), { recursive: true });
  writeFileSync(logFile, log.length > 262144 ? "[... truncated ...]" + String.fromCharCode(10) + log.slice(-262144) : log);
  const reportFile = join(runDir, "zap-report.json");
  const findings = authRejections(log, ls, envNames);
  if (findings.length) console.error(`\nLIVE SCAN AUTH FAILURE — ${findings.length} authenticated target(s) were NOT authenticated:\n` + findings.map((f) => `  ${f.id}: ${f.message}`).join("\n") + "\n");
  const preflightAborted = r.status === PREFLIGHT_EXIT;
  if (preflightAborted && !findings.length) findings.push({ check: "live-scan", id: "auth-preflight-failed", severity: "high", message: `auth preflight aborted the scan (see ${logFile})`, location: "" });
  let reportText = existsSync(reportFile) ? readFileSync(reportFile, "utf8") : null;
  if (r.status !== 0 && !preflightAborted && !reportText) findings.push({ check: "live-scan", id: "zap-failed", severity: "high", message: `ZAP exited ${r.status} without a report (see ${logFile})`, location: "" });
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
  const dl = loadDecisions(root, pd.decisions);
  const decided = applyDecisions(kept, dl, { ranChecks: ["live-scan"] });
  const { blocking, allowed } = applyAllowlist(decided.blocking, al, { ranChecks: [] });
  const structural = validateEntries(al, { checkIds: [...pd.checks.map((c) => c.id), "live-scan"], maxDays: pd.allowlistMaxDays });
  if (!allowlistCommitted(root, al)) structural.push({ check: "allowlist", id: "allowlist-uncommitted", severity: "high", message: "allowlist file is untracked or modified", location: al.path });
  structural.push(...validateDecisions(dl, { checkIds: [...pd.checks.map((c) => c.id), "live-scan"], maxAgeDays: pd.decisionsMaxAgeDays, ledger: dl.entries.length ? ledgerDecisionIds(root) : { ids: new Set(), error: null, file: "" } }), ...decided.stale);
  if (!decisionsCommitted(root, dl)) structural.push({ check: "decisions", id: "decision-uncommitted", severity: "high", message: "decision-backed exceptions file is untracked or modified", location: dl.path });
  const all = [...blocking, ...structural];
  const ts = nowIso();
  const record = {
    ts, sha, coversSeq, status: all.length ? "fail" : "pass", blocking: all.length, allowlisted: allowed.length, decisionBacked: decided.backed.length,
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
    console.log(`\nLIVE SCAN ${record.status.toUpperCase()}: ${all.length} blocking, ${allowed.length} allowlisted, ${decided.backed.length} DECISION-BACKED (permanent; essentials only). Record: ${join(dir, stamp + ".json")}`);
  }
  return all.length ? 1 : 0;
}

/** Record + report a scan that never ran because a target is down: status fail (debt stays), outcome target-down, no ZAP findings. */
export function recordTargetDown({ args, root, sha, coversSeq, ls, findings }) {
  const ts = nowIso();
  const record = {
    ts, sha, coversSeq, status: "fail", outcome: "target-down", blocking: findings.length, allowlisted: 0, decisionBacked: 0,
    targets: ls.targets.map((t) => t.id), targetsHash: sha256(canonicalJson(ls)), image: ls.image || "", findings,
  };
  const dir = join(stateDir(root), "live-scans");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ts.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  if (args.json) console.log(JSON.stringify(record, null, 2));
  else {
    console.error("\nLIVE SCAN BLOCKED - TARGET DOWN, SCAN NOT MEANINGFUL (no ZAP scan was run):\n" + findings.map((f) => `  ${f.id}: ${f.message}`).join("\n"));
    console.error(`\nThis is not a pass and not an app finding. Bring the target up, then re-run the live scan. Record: ${file}`);
  }
  return 1;
}

export { liveScans };

if (process.argv[1]?.endsWith("livescan.mjs")) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
}
