#!/usr/bin/env node
/**
 * run.mjs — the pre-deploy gate runner (`/predeploy-gate`).
 *
 *   node run.mjs [--root DIR] [--check ID ...] [--allow-dirty] [--pull] [--json] [--list]
 *                [--live]   (delegates to the live active scan, see livescan.mjs)
 *                [--rebaseline-image-debt [--owner X --plan "..." --due YYYY-MM-DD]]   (see imagedebt.mjs)
 *
 * Runs EVERY configured check against the exact HEAD commit, applies the
 * expiring allowlist, writes <state>/reports/<sha>.json, and — only when
 * every check passed on a clean tree and the full set ran — writes the stamp
 * <state>/stamps/<sha>.json bound to the sha, the config hash and the
 * allowlist hash. Exit 0 = stamp issued; 1 = findings; 2 = could not run.
 */
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PRESETS, ToolMissing } from "./catalog.mjs";
import { configHash, normalize, validatePredeploy } from "./config.mjs";
import { applyAllowlist, allowlistCommitted, allowlistHash, loadAllowlist, validateEntries } from "./allowlist.mjs";
import { applyDecisions, decisionsCommitted, decisionsHash, ledgerDecisionIds, loadDecisions, summarizeDecisions, validateDecisions } from "./decisions.mjs";
import { buildBaseline, evaluateImageDebt, imageDebtCommitted, imageDebtHash, loadImageDebt, scannedImages, trivyPins } from "./imagedebt.mjs";
import { nativePath, installHints, shq } from "./tools.mjs";
import { parseOutput } from "./parsers.mjs";
import { GATE_VERSION, findProjectRoot, git, headSha, loadMapleConfig, nowIso, runShell, sevRank, stateDir, trackedDirty } from "./lib.mjs";
import { liveScanDebt, reportPath, stampPath, writeJson } from "./state.mjs";
import { runRemote } from "./remote.mjs";

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

const SCANNER_IGNORE_FILES = /(^|\/)(\.checkov\.(ya?ml|baseline)|\.semgrepignore|\.trivyignore(\.yaml)?|trivy\.ya?ml|\.hadolint\.ya?ml|\.shellcheckrc)$/;

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

async function runCheck(check, pd, ctx) {
  const t0 = Date.now();
  const res = { id: check.id, kind: check.github ? "github" : check.preset ? "preset:" + check.preset : "command", findings: [], notes: [], meta: undefined };
  try {
    if (check.github) {
      const r = await runRemote(check, pd, ctx);
      Object.assign(res, { findings: r.findings, notes: r.notes || [], meta: r.meta });
    } else if (check.preset && PRESETS[check.preset].run) {
      const r = await PRESETS[check.preset].run(check.options || {}, ctx);
      Object.assign(res, { findings: r.findings, notes: r.notes || [] });
    } else {
      let spec;
      if (check.preset) spec = PRESETS[check.preset].build(check.options || {}, ctx);
      else spec = { command: check.command, parse: check.parse || "exit-code", reports: check.reports || [], cwd: "root", env: check.env };
      for (const f of spec.emptyFiles || []) writeFileSync(join(ctx.outDir, f), /\.ya?ml$/.test(f) ? "{}\n" : "");
      const cwd = spec.cwd === "scan" ? ctx.scanRoot : check.cwd ? join(ctx.root, check.cwd) : ctx.root;
      const out = runShell(spec.command, { cwd, env: { ...(spec.env || {}), PREDEPLOY_OUT: ctx.outDir, PREDEPLOY_SHA: ctx.sha }, timeoutSec: check.timeoutSec || 1800 });
      res.raw = { status: out.status };
      res.text = out.stdout + "\n" + out.stderr;
      if (out.timedOut) res.findings.push({ id: "timeout", severity: "high", message: `exceeded ${check.timeoutSec || 1800}s`, location: "" });
      else if (out.spawnError) res.findings.push({ id: "spawn-failed", severity: "high", message: out.spawnError, location: "" });
      else if (out.status === 127) res.findings.push({ id: "tool-missing", severity: "high", message: `command not found: ${out.stderr.trim().split(/\r?\n/).pop()}`, location: "" });
      else {
        const { readFileSync } = await import("node:fs");
        res.findings = parseOutput(spec.parse, {
          status: out.status, stdout: out.stdout, stderr: out.stderr, reports: spec.reports || [], repoRoot: ctx.root,
          readReport: (n) => { try { return readFileSync(join(ctx.outDir, n), "utf8"); } catch { return null; } },
        });
        if (out.status === 126) res.findings.push({ id: "tool-blocked", severity: "high", message: "command could not be executed (blocked or not executable)", location: "" });
      }
    }
  } catch (e) {
    if (e instanceof ToolMissing) res.findings = [{ id: "tool-missing", severity: "high", message: `${e.tool}: ${e.message}. Install: ${installHints(e.tool)}`, location: "" }];
    else res.findings = [{ id: "check-crashed", severity: "high", message: String(e.stack || e).split("\n").slice(0, 3).join(" | "), location: "" }];
  }
  const rel = (p) => String(p || "").split(ctx.scanRootPosix + "/").join("").split(ctx.scanRoot.replace(/\\/g, "/") + "/").join("");
  if (check.countPattern && res.findings.length && res.raw) {
    const text = res.text || "";
    let total = 0;
    for (const m of text.matchAll(new RegExp(check.countPattern, "g"))) total += Number(m[1]) || 0;
    if (total) res.estimated = total;
  }
  res.findings = res.findings.map((f) => ({ ...f, check: check.id, location: rel(f.location) }));
  res.ms = Date.now() - t0;
  return res;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/** One row per decision-backed entry (not per finding): scanner/rule scope -> D###, with how many findings it covers. */
const stripLine = (loc) => String(loc || "").replace(/:\d+(-\d+)?$/, "");
function decisionItems(backed) {
  const m = new Map();
  for (const f of backed) {
    const scope = f.decisionBacked.scope === "*" ? `* (rule-wide, up to ${f.decisionBacked.maxSeverity})` : f.resource ? stripLine(f.location) + "#" + f.resource : stripLine(f.location);
    const k = [f.check, f.id, scope].join("|");
    const cur = m.get(k) || { scanner: f.check, rule: f.id, scope, decision: f.decisionBacked.decision, reviewed: f.decisionBacked.reviewed, count: 0 };
    cur.count++;
    m.set(k, cur);
  }
  return [...m.values()];
}
const decisionLines = (backed) => decisionItems(backed).map((i) => `    decision-backed: ${i.scanner}/${i.rule} ${i.scope} -> ${i.decision} (reviewed ${i.reviewed}, ${i.count} finding${i.count === 1 ? "" : "s"})`);

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
  const args = parseArgs(argv);
  const root = args.root ? findProjectRoot(args.root) : findProjectRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  if (!root) { console.error("no maple.config.json found"); return 2; }
  if (args.live) {
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
  if (dirty && !args.allowDirty) { console.error("tracked files differ from HEAD. The gate certifies a commit — commit (or stash) first. (--allow-dirty runs without issuing a stamp.)"); return 2; }
  const sha = headSha(root);
  const al = loadAllowlist(root, pd.allowlist);
  const committed = allowlistCommitted(root, al);
  const dl = loadDecisions(root, pd.decisions);
  const dCommitted = decisionsCommitted(root, dl);
  const idl = pd.imageDebt ? loadImageDebt(root, pd.imageDebt.file) : null;

  const runDir = join(stateDir(root), "runs", sha.slice(0, 12));
  const outDir = join(runDir, "out");
  rmSync(runDir, { recursive: true, force: true });
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

  const selected = pd.checks.filter((c) => !subset || args.checks.includes(c.id));
  console.log(`predeploy gate — ${pd.policyRef ? "policy " + pd.policyRef + " — " : ""}${selected.length} check(s) on ${sha.slice(0, 8)}${dirty ? " (DIRTY — no stamp)" : ""}`);
  const results = await pool(selected, pd.concurrency, async (c) => {
    const r = await runCheck(c, pd, ctx);
    console.log(`  ${r.findings.length ? "FAIL" : " ok "}  ${c.id}  (${r.findings.length} raw finding(s), ${(r.ms / 1000).toFixed(1)}s)`);
    return r;
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
  const allCheckIds = [...pd.checks.map((c) => c.id), "live-scan"];
  let imageDebt = null;
  if (pd.imageDebt) {
    const pins = trivyPins(pd);
    const ranImages = scannedImages(results, pins);
    if (args.rebaseline) return rebaseline(root, pd, idl, allFindings, { pins, ranImages, today, args });
    imageDebt = evaluateImageDebt(allFindings, idl, { pins, ownImages: pd.imageDebt.ownImages, ranImages, today, maxDays: pd.imageDebt.maxDays });
    allFindings = imageDebt.remaining;
  }
  const idCommitted = idl ? imageDebtCommitted(root, idl) : true;
  const decided = applyDecisions(allFindings, dl, { ranChecks: decisionRanChecks });
  const structural = [
    ...validateEntries(al, { checkIds: allCheckIds, maxDays: pd.allowlistMaxDays }),
    ...validateDecisions(dl, { checkIds: allCheckIds, maxAgeDays: pd.decisionsMaxAgeDays, ledger: dl.entries.length ? ledgerDecisionIds(root) : { ids: new Set(), error: null, file: "" } }),
    ...decided.stale,
    ...(imageDebt ? imageDebt.blocking : []),
    ...(idCommitted ? [] : [{ check: "image-debt", id: "image-debt-uncommitted", severity: "high", message: "third-party image debt file is untracked or modified - the snapshot and due dates must be committed and reviewed", location: idl.path }]),
    ...(dCommitted ? [] : [{ check: "decisions", id: "decision-uncommitted", severity: "high", message: "decision-backed exceptions file is untracked or modified — permanent exceptions must be committed and reviewed", location: dl.path }]),
    ...(committed ? [] : [{ check: "allowlist", id: "allowlist-uncommitted", severity: "high", message: "allowlist file is untracked or modified — exceptions must be committed and reviewed", location: al.path }]),
  ];
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
    id: r.id, kind: r.kind, ms: r.ms,
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
    console.log(`\nreport: ${reportPath(root, sha)}`);
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
