#!/usr/bin/env node
/**
 * run.mjs — the pre-deploy gate runner (`/predeploy-gate`).
 *
 *   node run.mjs [--root DIR] [--check ID ...] [--allow-dirty] [--pull] [--json] [--list]
 *                [--live]   (delegates to the live active scan, see livescan.mjs)
 *                [--rebaseline-image-debt [--owner X --plan "..." --due YYYY-MM-DD]]   (see imagedebt.mjs)
 *   node run.mjs prune [--all] [--root DIR] [--json]   delete disposable run workspaces (see runs.mjs)
 *   node run.mjs doctor [--pull] [--json]               tools, credentials, runs/ size, free space
 *   node run.mjs preflight [--root DIR] [--check ID ...] [--allow-dirty] [--pull] [--json]
 *                                                       the fast verdicts only (seconds; gate-preflight.mjs). A gate
 *                                                       run starts with the same preflight and stops there (exit 1, no
 *                                                       scanner started) when it fails and the run could stamp.
 *
 * Runs EVERY configured check against the exact HEAD commit, applies the
 * expiring allowlist, writes <state>/reports/<sha>.json, and — only when
 * every check passed on a clean tree and the full set ran — writes the stamp
 * <state>/stamps/<sha>.json bound to the sha, the config hash and the
 * allowlist hash. Exit 0 = stamp issued; 1 = findings; 2 = could not run.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { configHash, normalize, validatePredeploy } from "./config.mjs";
import { applyAllowlist, allowlistHash, loadAllowlist } from "./allowlist.mjs";
import { applyDecisions, decisionsHash, loadDecisions, summarizeDecisions } from "./decisions.mjs";
import { buildBaseline, evaluateImageDebt, imageDebtHash, loadImageDebt, scannedImages, trivyPins } from "./imagedebt.mjs";
import { nativePath, shq } from "./tools.mjs";
import { GATE_VERSION, findProjectRoot, git, headSha, loadMapleConfig, nowIso, sevRank, stateDir, trackedDirty } from "./lib.mjs";
import { liveScanDebt, reportPath, stampPath, writeJson } from "./state.mjs";
import { beginRun, fmtGB, finishRun, preflight, pruneCli } from "./runs.mjs";
import { runChecks } from "./check-runner.mjs";
import { gatePreflight, preflightLines, structuralFindings } from "./gate-preflight.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = { checks: [], root: null, json: false, pull: false, allowDirty: false, list: false, live: false, rebaseline: false, owner: null, plan: null, due: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--root") a.root = argv[++i];
    else if (v === "--check") a.checks.push(argv[++i]);
    else if (v === "--json") a.json = true;
    else if (v === "--pull") a.pull = true;
    else if (v === "--allow-dirty") a.allowDirty = true;
    else if (v === "--list") a.list = true;
    else if (v === "--live") a.live = true;
    else if (v === "--rebaseline-image-debt") a.rebaseline = true;
    else if (v === "--owner") a.owner = argv[++i];
    else if (v === "--plan") a.plan = argv[++i];
    else if (v === "--due") a.due = argv[++i];
    else { console.error(`unknown argument: ${v}`); process.exit(2); }
  }
  return a;
}

const SCANNER_IGNORE_FILES = /(^|\/)(\.checkov\.(ya?ml|baseline)|\.semgrepignore|\.snyk|\.trivyignore(\.yaml)?|trivy\.ya?ml|\.hadolint\.ya?ml|\.shellcheckrc)$/;

const posix = (p) => nativePath(p).replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

function makeCtx(root, pd, sha, outDir, scanRoot, args) {
  const tracked = (git(root, ["ls-tree", "-r", "--name-only", sha]) || "").split(/\r?\n/).filter(Boolean);
  return {
    root, sha, outDir, scanRoot,
    rootPosix: posix(root), scanRootPosix: posix(scanRoot), outDirPosix: posix(outDir),
    stateDir: stateDir(root),
    docker: pd.docker.enabled !== false,
    exemptFiles: [pd.allowlist, pd.decisions, ...(pd.imageDebt ? [pd.imageDebt.file] : [])],
    pull: args.pull || process.env.PREDEPLOY_PULL === "1",
    listFiles: (re) => tracked.filter((f) => re.test(f)),
    lockDirs: () => [...new Set(tracked.filter((f) => /(^|\/)package-lock\.json$/.test(f)).map((f) => f.replace(/\/?package-lock\.json$/, "") || "."))],
  };
}

function exportTree(root, sha, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const r = spawnSync("bash", ["-c", `git -C ${shq(posix(root))} archive --format=tar ${sha} | tar -x -C ${shq(posix(dest))}`], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("git archive export failed: " + (r.stderr || "").slice(0, 200));
}

/** One row per decision-backed entry (not per finding): scanner/rule scope -> D###, with how many findings it covers. */
const stripLine = (loc) => String(loc || "").replace(/:\d+(-\d+)?$/, "");
function decisionItems(backed) {
  const m = new Map();
  for (const f of backed) {
    const scope = f.decisionBacked.scope === "*" ? `* (rule-wide, up to ${f.decisionBacked.maxSeverity})` : f.resource ? stripLine(f.location) + "#" + f.resource : stripLine(f.location);
    const k = [f.check, f.id, scope].join("|");
    const cur = m.get(k) || { scanner: f.check, rule: f.id, scope, decision: f.decisionBacked.decision, reviewed: f.decisionBacked.reviewed, expires: f.decisionBacked.expires, count: 0 };
    cur.count++;
    m.set(k, cur);
  }
  return [...m.values()];
}
const decisionLines = (backed) => decisionItems(backed).map((i) => `    decision-backed: ${i.scanner}/${i.rule} ${i.scope} -> ${i.decision} (reviewed ${i.reviewed}${i.expires ? `, expires ${i.expires}` : ""}, ${i.count} finding${i.count === 1 ? "" : "s"})`);

/** Make allowlisted findings impossible to mistake for zero: counts + soonest expiry, baseline entries called out. */
function summarizeAllowlist(allowed, al) {
  const lines = [];
  const byExpiry = new Map();
  for (const f of allowed) {
    const a = f.allowlist;
    const k = `${a.expires}|${/^baseline/i.test(a.reason) ? "baseline" : "exception"}`;
    byExpiry.set(k, (byExpiry.get(k) || 0) + 1);
  }
  for (const [k, n] of [...byExpiry].sort()) {
    const [exp, kind] = k.split("|");
    lines.push(`*** ${n} ${kind} ${kind === "baseline" ? "exceptions" : "allowlisted findings"} expiring ${exp} — NOT ZERO; this gate is passing them only until then ***`);
  }
  if (al.entries.length && !allowed.length) lines.push(`(allowlist has ${al.entries.length} entries; none matched a finding this run)`);
  return { total: allowed.length, entries: al.entries.length, lines, byExpiry: Object.fromEntries(byExpiry) };
}

/** `--rebaseline-image-debt`: write a fresh snapshot file from this run's scans; the owner reviews and commits the diff. */
function rebaseline(root, pd, idl, findings, { pins, ranImages, today, args }) {
  const r = buildBaseline(findings, idl, { pins, ownImages: pd.imageDebt.ownImages, ranImages, today, maxDays: pd.imageDebt.maxDays, flags: { owner: args.owner, plan: args.plan, due: args.due } });
  if (r.errors.length) { console.error("cannot re-baseline image debt:\n  " + r.errors.join("\n  ")); return 2; }
  writeFileSync(join(root, pd.imageDebt.file), r.text);
  console.log("");
  for (const c of r.changes) console.log(c.dropped ? `  - ${c.name}: entry dropped (not a pinned third-party image any more)` : `  ${c.created ? "+ NEW" : "  "} ${c.name}: ${c.total} finding(s) (+${c.added} added, -${c.removed} removed)`);
  const added = r.changes.reduce((n, c) => n + (c.added || 0), 0);
  console.log(`\nwrote ${pd.imageDebt.file}${added ? ` - it ADDS ${added} finding(s) to the accepted debt; review the diff` : ""}. Commit it (the gate needs it committed); due dates are preserved, never extended.`);
  return 0;
}

export async function main(argv, opts = {}) {
  const today = opts.today || new Date();
  if (argv[0] === "doctor") return spawnSync(process.execPath, [join(HERE, "doctor.mjs"), ...argv.slice(1)], { stdio: "inherit" }).status ?? 2;
  if (argv[0] === "prune") {
    const i = argv.indexOf("--root");
    const r = findProjectRoot(i >= 0 ? argv[i + 1] : process.env.CLAUDE_PROJECT_DIR || process.cwd());
    if (!r) { console.error("no maple.config.json found"); return 2; }
    const rest = argv.slice(1).filter((a, k, all) => a !== "--root" && all[k - 1] !== "--root");
    return pruneCli(rest, r, normalize(loadMapleConfig(r)), { pruneCmd: `node "${join(HERE, "run.mjs")}" prune --all` });
  }
  const preflightOnly = argv[0] === "preflight";
  const args = parseArgs(preflightOnly ? argv.slice(1) : argv);
  const root = args.root ? findProjectRoot(args.root) : findProjectRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) { console.error("no maple.config.json found"); return 2; }
  if (args.live && !preflightOnly) {
    const { main: live } = await import("./livescan.mjs");
    return live(["--root", root, ...(args.pull ? ["--pull"] : []), ...(args.json ? ["--json"] : [])]);
  }
  const cfg = loadMapleConfig(root);
  const problems = validatePredeploy(cfg);
  if (problems.length) { console.error("predeploy config invalid:\n  " + problems.join("\n  ")); return 2; }
  const pd = normalize(cfg);
  if (!pd) { console.error("maple.config.json has no `predeploy` block — nothing to run"); return 2; }
  if (args.list) { for (const c of pd.checks) console.log(`${c.id}\t${c.github ? "github:" + c.github : c.preset ? "preset:" + c.preset : "command"}`); return 0; }

  if (args.rebaseline) {
    if (!pd.imageDebt) { console.error("--rebaseline-image-debt needs predeploy.imageDebt in maple.config.json"); return 2; }
    if (args.checks.length) { console.error("--rebaseline-image-debt scans every trivy-image check itself; do not combine with --check"); return 2; }
    args.checks = pd.checks.filter((c) => c.preset === "trivy-image").map((c) => c.id);
  }
  const subset = args.checks.length > 0;
  for (const id of args.checks) if (!pd.checks.some((c) => c.id === id)) { console.error(`no such check: ${id}`); return 2; }
  const dirty = trackedDirty(root);
  if (dirty && !args.allowDirty && !preflightOnly) { console.error("tracked files differ from HEAD. The gate certifies a commit — commit (or stash) first. (--allow-dirty runs without issuing a stamp.)"); return 2; }
  const sha = headSha(root);
  const al = loadAllowlist(root, pd.allowlist);
  const dl = loadDecisions(root, pd.decisions);
  const idl = pd.imageDebt ? loadImageDebt(root, pd.imageDebt.file) : null;

  // Fast verdicts first (seconds): the same ones the full run would reach only after every scanner (gate-preflight.mjs).
  const selected = pd.checks.filter((c) => !subset || args.checks.includes(c.id));
  const pf = await gatePreflight({ root, pd, sha, selected, subset, rebaseline: args.rebaseline, allowDirty: args.allowDirty, today, pull: args.pull || process.env.PREDEPLOY_PULL === "1", al, dl, idl, ...(opts.preflightSeams || {}) });
  const stamping = !subset && !dirty;
  if (preflightOnly || !pf.ok) {
    const head = `preflight — ${pf.ok ? "ok" : pf.failures.length + " failure(s)"} in ${(pf.ms / 1000).toFixed(1)}s on ${sha.slice(0, 8)} (${selected.length} check(s))`;
    if (args.json && preflightOnly) console.log(JSON.stringify({ sha, ...pf }, null, 2));
    else {
      console.log(head);
      for (const l of preflightLines(pf)) console.log(l);
      for (const n of pf.notes) console.log(`  preflight note: ${n}`);
    }
    if (preflightOnly) return pf.ok ? 0 : 1;
    if (stamping) {
      writeJson(reportPath(root, sha), { version: GATE_VERSION, sha, ts: nowIso(), stage: "preflight", status: "fail", subset, dirty, policyRef: pd.policyRef || null, configHash: configHash(pd), totals: { blocking: pf.failures.length }, checks: [], blocking: pf.failures, preflight: pf });
      console.log(`\nGATE FAILED IN PREFLIGHT: ${pf.failures.length} blocking finding(s); no scanner was started. No stamp.\nreport: ${reportPath(root, sha)}`);
      return 1;
    }
    console.log("  (this run cannot issue a stamp: preflight failures are advisory; the run continues)");
  }

  const pre = preflight(root, pd, { pruneCmd: `node "${join(HERE, "run.mjs")}" prune --all`, log: (m) => console.log(m), free: opts.free });
  if (!pre.ok) { console.error(pre.message); return 2; }
  const run = beginRun(root, sha.slice(0, 12));
  let code = 2;
  try {
    code = await gateBody({ args, today, root, pd, subset, dirty, sha, al, dl, idl, selected, pf, runDir: run.dir });
    return code;
  } finally {
    const done = finishRun(run, { sha, exit: code });
    if (!args.json) console.log(`run workspace pruned (${fmtGB(done.freedBytes)} freed): ${run.dir}`);
    for (const e of done.errors.slice(0, 5)) console.error(`could not remove: ${e}`);
  }
}

async function gateBody({ args, today, root, pd, subset, dirty, sha, al, dl, idl, selected, pf, runDir }) {
  const outDir = join(runDir, "out");
  mkdirSync(outDir, { recursive: true });
  const scanRoot = join(runDir, "tree");
  exportTree(root, sha, scanRoot);
  const ctx = makeCtx(root, pd, sha, outDir, scanRoot, args);
  // A rebaseline snapshots third-party images only: our own images are never debt, so do not build/scan them.
  if (args.rebaseline) ctx.onlyImages = new Set(trivyPins(pd).filter((p) => !pd.imageDebt.ownImages.includes(p.name)).map((p) => p.name));
  // Scanners auto-load their own ignore/config files from the tree (checkov even alongside --config-file).
  // The scan copy never contains them, so a suppression file cannot hide a finding; suppression-audit
  // still flags the tracked originals.
  for (const f of ctx.listFiles(SCANNER_IGNORE_FILES)) rmSync(join(scanRoot, f), { force: true });

  console.log(`predeploy gate — ${pd.policyRef ? "policy " + pd.policyRef + " — " : ""}${selected.length} check(s) on ${sha.slice(0, 8)}${dirty ? " (DIRTY — no stamp)" : ""}, ${pd.concurrency} at a time (lines print as checks finish)`);
  const { results, timing } = await runChecks(selected, pd, ctx, {
    log: (r) => console.log(`  ${r.findings.length ? "FAIL" : " ok "}  ${r.id}  (${r.findings.length} raw finding(s), ${(r.ms / 1000).toFixed(1)}s${r.queuedMs >= 1000 ? `, queued ${(r.queuedMs / 1000).toFixed(0)}s` : ""})`),
  });

  // minSeverity floors, then the allowlist
  const floorBy = new Map(pd.checks.map((c) => [c.id, c.minSeverity || pd.minSeverity]));
  let allFindings = [];
  const belowFloor = {};
  for (const r of results) {
    const floor = sevRank(floorBy.get(r.id));
    const kept = r.findings.filter((f) => sevRank(f.severity) >= floor);
    belowFloor[r.id] = r.findings.length - kept.length;
    allFindings.push(...kept);
  }
  // A check that could not run (tool missing, no report, crash, timeout) says nothing about whether a
  // decision-backed entry still matches, so it neither confirms nor stales entries; its own failure already blocks.
  const INFRA_FAILURE = /^(tool-missing|tool-blocked|no-report|unparseable-report|check-crashed|spawn-failed|timeout|misconfigured|token-missing|secret-missing)$/;
  const ranChecks = results.map((r) => r.id);
  const decisionRanChecks = results.filter((r) => !r.findings.some((f) => INFRA_FAILURE.test(f.id))).map((r) => r.id);
  let imageDebt = null;
  if (pd.imageDebt) {
    const pins = trivyPins(pd);
    const ranImages = scannedImages(results, pins);
    if (args.rebaseline) return rebaseline(root, pd, idl, allFindings, { pins, ranImages, today, args });
    imageDebt = evaluateImageDebt(allFindings, idl, { pins, ownImages: pd.imageDebt.ownImages, ranImages, today, maxDays: pd.imageDebt.maxDays });
    allFindings = imageDebt.remaining;
  }
  const decided = applyDecisions(allFindings, dl, { ranChecks: decisionRanChecks, today });
  const structural = structuralFindings(root, pd, { al, dl, idl, today, stale: decided.stale, imageDebtBlocking: imageDebt ? imageDebt.blocking : [] });
  const { blocking, allowed, unused } = applyAllowlist(decided.blocking, al, { ranChecks });
  const debt = !subset ? liveScanDebt(root, pd) : { ok: true, reason: "skipped (subset run)" };
  const debtFindings = debt.ok ? [] : [{ check: "live-scan", id: "live-scan-debt", severity: "high", message: debt.reason, location: "" }];
  const unusedWarn = pd.allowlistUnused === "warn";
  const allBlocking = [...blocking, ...(unusedWarn ? [] : unused), ...structural, ...debtFindings];
  const baseline = summarizeAllowlist(allowed, al);
  const debtLines = imageDebt ? imageDebt.lines : [];
  const decisionSummary = summarizeDecisions(decided.backed, dl, pd.decisionsMaxAgeDays);
  const unusedNote = unusedWarn && unused.length ? [`${unused.length} allowlist entr${unused.length === 1 ? "y" : "ies"} matched nothing this run (fixed or flaky) — prune them (predeploy.allowlistUnused=warn)`] : [];

  const perCheck = results.map((r) => ({
    id: r.id, kind: r.kind, ms: r.ms, startedAt: r.startedAt, endedAt: r.endedAt, queuedMs: r.queuedMs,
    raw: r.findings.length, estimated: r.estimated, belowFloor: belowFloor[r.id],
    blocking: allBlocking.filter((f) => f.check === r.id).length,
    allowlisted: allowed.filter((f) => f.check === r.id).length,
    decisionBacked: decided.backed.filter((f) => f.check === r.id).length,
    imageDebt: imageDebt ? imageDebt.debt.filter((f) => f.check === r.id).length : 0,
    notes: r.notes, meta: r.meta,
  }));
  const report = {
    allowlistSummary: baseline,
    decisionExceptions: { ...decisionSummary, items: decisionItems(decided.backed) },
    imageDebt: imageDebt ? { total: imageDebt.total, imagesWithDebt: imageDebt.imagesWithDebt, dueEarliest: imageDebt.dueEarliest, rule: imageDebt.rule, images: imageDebt.images } : null,
    imageDebtHash: idl ? imageDebtHash(idl) : null,
    version: GATE_VERSION, sha, ts: nowIso(), subset, dirty, policyRef: pd.policyRef || null,
    configHash: configHash(pd), allowlistHash: allowlistHash(al), decisionsHash: decisionsHash(dl),
    status: allBlocking.length === 0 ? "pass" : "fail",
    totals: { blocking: allBlocking.length, allowlisted: allowed.length, decisionBacked: decided.backed.length, imageDebt: imageDebt ? imageDebt.total : 0 },
    checks: perCheck, blocking: allBlocking, allowlisted: allowed, decisionBacked: decided.backed,
    liveScan: debt,
    timing, preflight: { ok: pf.ok, ms: pf.ms, failures: pf.failures, warnings: pf.warnings, notes: pf.notes },
  };
  writeJson(reportPath(root, sha), report);

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log("");
    for (const l of decisionSummary.lines) console.log(l);
    for (const l of debtLines) console.log(l);
    for (const l of decisionLines(decided.backed)) console.log(l);
    for (const l of baseline.lines) console.log(l);
    for (const n of unusedNote) console.log("NOTE: " + n);
    for (const c of perCheck) {
      console.log(`${c.blocking ? "FAIL" : " ok "}  ${c.id.padEnd(22)} blocking=${c.blocking}${c.estimated ? ` (~${c.estimated} underlying)` : ""} allowlisted=${c.allowlisted}${c.decisionBacked ? ` decisionBacked=${c.decisionBacked}` : ""}${c.imageDebt ? ` imageDebt=${c.imageDebt}` : ""}${c.belowFloor ? ` belowFloor=${c.belowFloor}` : ""}`);
      for (const n of c.notes || []) console.log(`        note: ${n}`);
    }
    const extra = allBlocking.filter((f) => !perCheck.some((c) => c.id === f.check));
    if (extra.length) console.log(`FAIL  ${"(gate bookkeeping)".padEnd(22)} blocking=${extra.length}`);
    console.log("");
    for (const f of allBlocking.slice(0, 400)) console.log(`  [${f.check}] ${f.id} ${f.location || ""} — ${String(f.message).split("\n")[0].slice(0, 160)}`);
    if (allBlocking.length > 400) console.log(`  ... ${allBlocking.length - 400} more (see report)`);
    console.log(`\nchecks took ${(timing.wallMs / 60000).toFixed(1)} min wall clock (${(timing.checkMsSum / 60000).toFixed(1)} min of check time, ${timing.concurrency} at a time; preflight ${(pf.ms / 1000).toFixed(1)}s)`);
    console.log(`report: ${reportPath(root, sha)}`);
  }

  if (allBlocking.length === 0 && !subset && !dirty) {
    const ttl = pd.stampTtlHours * 3600000;
    const remote = perCheck.map((c) => c.meta).filter(Boolean);
    writeJson(stampPath(root, sha), {
      version: GATE_VERSION, status: "pass", sha, tree: git(root, ["rev-parse", `${sha}^{tree}`]),
      issuedAt: nowIso(), expiresAt: new Date(Date.now() + ttl).toISOString(),
      configHash: configHash(pd), allowlistHash: allowlistHash(al), decisionsHash: decisionsHash(dl),
      ...(idl ? { imageDebtHash: imageDebtHash(idl), imageDebt: imageDebt.total } : {}),
      checks: perCheck.map((c) => ({ id: c.id, allowlisted: c.allowlisted, decisionBacked: c.decisionBacked, imageDebt: c.imageDebt })), allowlisted: allowed.length, decisionBacked: decided.backed.length,
      remote, by: process.env.USERNAME || process.env.USER || "unknown",
    });
    for (const l of decisionSummary.lines) console.log(l);
    for (const l of debtLines) console.log(l);
    for (const l of baseline.lines) console.log(l);
    console.log(`\nSTAMP ISSUED for ${sha.slice(0, 8)} (valid ${pd.stampTtlHours}h, bound to config + allowlist)`);
    return 0;
  }
  if (allBlocking.length === 0) { console.log("\nclean, but no stamp: " + (subset ? "subset run" : "dirty tree")); return 0; }
  for (const l of decisionSummary.lines) console.log(l);
    for (const l of debtLines) console.log(l);
  for (const l of baseline.lines) console.log(l);
  console.log(`\nGATE FAILED: ${allBlocking.length} blocking finding(s) across ${new Set(allBlocking.map((f) => f.check)).size} check(s). No stamp.`);
  return 1;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("run.mjs")) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
}
