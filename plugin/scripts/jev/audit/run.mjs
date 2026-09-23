#!/usr/bin/env node
/**
 * Per-function code-quality audit, powered by Jev (TypeSafe System One) —
 * the plugin-canonical copy (docs/decisions.md D051: gates live in the
 * plugin). Ported from MapleLens's tools/jev/audit.mjs, generalized so
 * config comes from the TARGET repo's `maple.config.json` `quality.jevAudit`
 * block (see ./config.mjs) instead of a bundled JSON file, and using this
 * plugin's own Jev client (./client.mjs — Pi-first routing, DPAPI credential
 * cache) rather than MapleLens's tools/jev/client.mjs.
 *
 *   node run.mjs [--repo <path>] [--full] [--gate] [--dry-run]
 *                [--concurrency N] [--no-dup] [--report] [--base <branch>]
 *
 * `runAudit()` takes its Jev caller and file-system reads as injectable
 * arguments (same seam as the MapleLens original) so the test suite makes
 * no network call and shells out to nothing.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { safeEvaluate } from "../client.mjs";
import { discoverAllFiles, discoverChangedFiles, discoverTestFiles, extractFromSource, makeDenylistTest, moduleOf } from "./extract.mjs";
import { dedupeNearDuplicatePairs, dupCacheKey, findCandidatePairs, findExactDuplicateClusters, selectPairsForJev } from "./fingerprint.mjs";
import { DUPLICATE_QUESTION, FUNCTION_QUESTIONS, QUESTIONS_VERSION, hasTestReference } from "./questions.mjs";
import { buildReport, renderHtmlReport } from "./report.mjs";
import { resolveAuditStateDir } from "./state-dir.mjs";
import { evaluateGate, formatGateReport } from "./gate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Composite cache key: body hash + QUESTIONS_VERSION — a reworded question invalidates every cached answer. */
function cacheKeyFor(bodyHash) {
  return `${bodyHash}::${QUESTIONS_VERSION}`;
}

function readCachedScore(cache, bodyHash) {
  const hit = cache[cacheKeyFor(bodyHash)];
  return hit ? { scores: hit.scores, confidences: hit.confidences } : null;
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

export function aggregateUsage(usageList) {
  const totals = { calls: 0 };
  for (const u of usageList) {
    if (!u || typeof u !== "object") continue;
    totals.calls++;
    for (const [k, v] of Object.entries(u)) {
      if (typeof v === "number") totals[k] = (totals[k] ?? 0) + v;
    }
  }
  return totals;
}

/**
 * The base branch a "changed files" run diffs against: `opts.baseBranch`
 * (e.g. maple-land's own landing target — see the gate wiring doc), else
 * the target repo's own `maple.config.json` `repo.devBranch`, else "main".
 */
export async function resolveBaseBranch(explicitBase, targetCwd, readFileFn = readFile) {
  if (explicitBase) return explicitBase;
  try {
    const raw = await readFileFn(path.join(targetCwd, "maple.config.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.repo?.devBranch) return parsed.repo.devBranch;
  } catch {
    // no maple.config.json, or it doesn't parse — "main" is still a reasonable default.
  }
  return "main";
}

async function extractAll(files, { cwd, config, isDenylisted, readFileFn }) {
  const out = [];
  for (const relFile of files) {
    let text;
    try {
      text = await readFileFn(path.join(cwd, relFile), "utf8");
    } catch {
      continue; // deleted between discovery and read
    }
    const fns = extractFromSource(relFile, text, {
      trivialMaxStatements: config.trivialMaxStatements,
      trivialMaxLines: config.trivialMaxLines,
      maxSourceBytes: config.maxSourceBytes,
    });
    for (const fn of fns) {
      fn.module = moduleOf(relFile, config);
      fn.denylisted = isDenylisted(relFile, fn.qualifiedName);
      out.push(fn);
    }
  }
  return out;
}

async function judgeFunction(fn, evaluateFn) {
  const result = await evaluateFn(
    { file: fn.file, function_name: fn.qualifiedName, imports: fn.imports, source: fn.source },
    FUNCTION_QUESTIONS,
  );
  if (!result) return null; // fail-open: Jev unavailable for this call
  const { answers, usage } = result;
  return {
    scores: {
      security: answers.security.score,
      efficiency: answers.efficiency.score,
      clarity: answers.clarity.score,
      error_handling: answers.error_handling.noul,
      edge_cases: answers.edge_cases.noul,
      can_fail: answers.can_fail?.noul ?? null,
    },
    confidences: {
      security: answers.security.confidence,
      efficiency: answers.efficiency.confidence,
      clarity: answers.clarity.confidence,
      error_handling: answers.error_handling.confidence,
      edge_cases: answers.edge_cases.confidence,
    },
    usage,
  };
}

async function judgeDuplicatePair(aSource, bSource, evaluateFn) {
  const result = await evaluateFn({ function_a: aSource, function_b: bSource }, DUPLICATE_QUESTION);
  if (!result) return null;
  return { probability: result.answers.same_job.noul, confidence: result.answers.same_job.confidence, usage: result.usage };
}

async function judgeOrCacheDuplicatePair(pair, a, b, { dupCache, evaluateFn }) {
  const key = dupCacheKey(cacheKeyFor(a.bodyHash), cacheKeyFor(b.bodyHash));
  const cached = dupCache[key];
  if (cached) return { probability: cached.probability, confidence: cached.confidence, fromCache: true };
  const result = await judgeDuplicatePair(a.source, b.source, evaluateFn);
  if (!result) return { skipped: true };
  dupCache[key] = { probability: result.probability, confidence: result.confidence };
  return result;
}

/**
 * @param {object} opts
 * @param {string} opts.cwd  target repo root
 * @param {object} opts.config  resolveJevAuditConfig(cwd) shape
 * @param {'changed'|'full'} [opts.mode]
 * @param {string} [opts.baseBranch]  explicit base for "changed" mode (e.g. the landing target)
 * @param {boolean} [opts.noDup]
 * @param {number} [opts.concurrency]
 * @param {object} [opts.cache]  mutated in place
 * @param {object} [opts.dupCache]  mutated in place
 * @param {Function} [opts.evaluateFn]  (state, questions) -> {answers, usage} | null on failure — injectable, defaults to a safeEvaluate(root, ...) wrapper
 * @param {Function} [opts.readFileFn]
 */
export async function runAudit(opts) {
  const {
    cwd,
    config,
    mode = "changed",
    baseBranch,
    noDup = false,
    concurrency = 6,
    cache = {},
    dupCache = {},
    evaluateFn = (state, questions) => safeEvaluate(cwd, state, questions),
    readFileFn = readFile,
    discoverChangedFilesFn = discoverChangedFiles,
    discoverAllFilesFn = discoverAllFiles,
    discoverTestFilesFn = discoverTestFiles,
  } = opts;

  const isDenylisted = makeDenylistTest(config);

  const scopeFiles =
    mode === "full"
      ? await discoverAllFilesFn(config, cwd, [])
      : await discoverChangedFilesFn(config, cwd, [], await resolveBaseBranch(baseBranch, cwd, readFileFn));
  const inScopeFunctions = await extractAll(scopeFiles, { cwd, config, isDenylisted, readFileFn });

  let universeFunctions = inScopeFunctions;
  if (!noDup && mode !== "full") {
    const allFiles = await discoverAllFilesFn(config, cwd, []);
    universeFunctions = await extractAll(allFiles, { cwd, config, isDenylisted, readFileFn });
  }

  const testFiles = mode === "full" || inScopeFunctions.length > 0 ? await discoverTestFilesFn(cwd) : [];
  const testFileContents = [];
  for (const f of testFiles) {
    try {
      testFileContents.push(await readFileFn(path.join(cwd, f), "utf8"));
    } catch {
      // deleted between listing and reading
    }
  }
  for (const fn of inScopeFunctions) fn.hasTestReference = hasTestReference(fn.name, testFileContents);

  const denylistedFiles = [...new Set(inScopeFunctions.filter((f) => f.denylisted).map((f) => f.file))].sort();

  const toCall = [];
  for (const fn of inScopeFunctions) {
    if (fn.denylisted) continue;
    const cached = readCachedScore(cache, fn.bodyHash);
    if (cached) {
      fn.scores = cached.scores;
      fn.confidences = cached.confidences;
      fn.fromCache = true;
    } else {
      toCall.push(fn);
    }
  }

  let candidatePairs = [];
  let selectedPairs = [];
  let exactDuplicateClusters = [];
  let dupStats = { droppedForCap: 0, droppedForDenylist: 0 };
  if (!noDup) {
    const inScopeIds = new Set(inScopeFunctions.map((f) => f.id));
    const byId = new Map(universeFunctions.map((f) => [f.id, f]));
    exactDuplicateClusters = findExactDuplicateClusters(universeFunctions, { inScopeIds });
    candidatePairs = findCandidatePairs(universeFunctions, { shingleSize: config.shingleSize, threshold: config.jaccardThreshold });
    const nearDuplicatePairs = dedupeNearDuplicatePairs(candidatePairs, byId);
    const sel = selectPairsForJev(nearDuplicatePairs, {
      inScopeIds,
      isDenylistedId: (id) => byId.get(id)?.denylisted ?? false,
      cap: config.jevPairCap,
    });
    selectedPairs = sel.pairs;
    dupStats = { droppedForCap: sel.droppedForCap, droppedForDenylist: sel.droppedForDenylist };
  }

  const usageList = [];
  let jevCallsAttempted = 0;
  let jevCallsFailed = 0;

  {
    const judgeResults = await mapLimit(toCall, concurrency, (fn) => {
      jevCallsAttempted++;
      return judgeFunction(fn, evaluateFn);
    });
    for (let i = 0; i < toCall.length; i++) {
      const fn = toCall[i];
      const result = judgeResults[i];
      if (result.ok && result.value) {
        fn.scores = result.value.scores;
        fn.confidences = result.value.confidences;
        fn.fromCache = false;
        usageList.push(result.value.usage);
        cache[cacheKeyFor(fn.bodyHash)] = { scores: fn.scores, confidences: fn.confidences };
      } else {
        fn.unjudged = true;
        jevCallsFailed++;
        if (!result.ok) console.error(`[quality-gate] unjudged ${fn.id}: ${result.error.message}`);
      }
    }
  }

  const byIdForDup = new Map(universeFunctions.map((f) => [f.id, f]));
  const dupResults = await mapLimit(selectedPairs, concurrency, (pair) => {
    const a = byIdForDup.get(pair.aId);
    const b = byIdForDup.get(pair.bId);
    jevCallsAttempted++;
    return judgeOrCacheDuplicatePair(pair, a, b, { dupCache, evaluateFn });
  });
  const duplicatePairs = selectedPairs.map((pair, i) => {
    const r = dupResults[i];
    if (r.ok) {
      const v = r.value;
      if (v.skipped) {
        jevCallsFailed++;
        return { ...pair, sameJobProbability: null, confidence: null, unjudged: true };
      }
      if (v.usage) usageList.push(v.usage);
      return { ...pair, sameJobProbability: v.probability, confidence: v.confidence, fromCache: v.fromCache ?? false };
    }
    jevCallsFailed++;
    console.error(`[quality-gate] duplicate check failed for ${pair.aId} / ${pair.bId}: ${r.error.message}`);
    return { ...pair, sameJobProbability: null, confidence: null, unjudged: true };
  });

  const usageTotals = aggregateUsage(usageList);
  // Jev is "unavailable" for this run when every single attempted call
  // failed/was skipped (not merely "this one function's call failed") — a
  // partial outage still lets the calls that DID succeed count normally.
  const jevUnavailable = jevCallsAttempted > 0 && jevCallsFailed === jevCallsAttempted;

  const report = buildReport({
    functions: inScopeFunctions,
    duplicatePairs,
    exactDuplicateClusters,
    runInfo: { mode, generatedBy: "plugin/scripts/jev/audit/run.mjs", questionsVersion: QUESTIONS_VERSION },
    usageTotals,
    dupStats,
    denylistedFiles,
  });

  return { report, usageTotals, cache, dupCache, denylistedFiles, jevUnavailable };
}

// ── CLI ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--full") args.full = true;
    else if (a === "--gate") args.gate = true;
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--no-dup") args.noDup = true;
    else if (a === "--report") args.report = true;
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

async function readCache(cachePath) {
  try {
    return JSON.parse(await readFile(cachePath, "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("node run.mjs [--repo <path>] [--full] [--gate] [--concurrency N] [--no-dup] [--report] [--base <branch>]");
    return;
  }

  const { resolveJevAuditConfig } = await import("./config.mjs");
  const targetCwd = args.repo ? path.resolve(process.cwd(), args.repo) : process.cwd();
  const config = resolveJevAuditConfig(targetCwd);

  if (!config.enabled) {
    console.log("[quality-gate] quality.jevAudit.enabled is false (or unset) — nothing to do.");
    return;
  }

  const stateDir = await resolveAuditStateDir(targetCwd, config.slug);
  const cachePath = path.join(stateDir, "cache.json");
  const dupCachePath = path.join(stateDir, "dup-cache.json");
  const cache = await readCache(cachePath);
  const dupCache = await readCache(dupCachePath);

  const result = await runAudit({
    cwd: targetCwd,
    config,
    mode: args.full ? "full" : "changed",
    baseBranch: args.base ?? config.baseBranch,
    noDup: !!args.noDup,
    concurrency: args.concurrency ?? 6,
    cache,
    dupCache,
  });

  await mkdir(stateDir, { recursive: true });
  await writeFile(cachePath, JSON.stringify(result.cache, null, 2));
  await writeFile(dupCachePath, JSON.stringify(result.dupCache, null, 2));
  await writeFile(path.join(stateDir, "report.json"), JSON.stringify(result.report, null, 2));
  if (args.report) {
    await writeFile(path.join(stateDir, "report.html"), renderHtmlReport(result.report));
    console.log(`Wrote ${path.join(stateDir, "report.html")}`);
  }

  const r = result.report;
  console.log(`\n[quality-gate] ${r.runInfo.mode} mode`);
  console.log(`  extracted: ${r.totals.extracted}  audited: ${r.totals.audited}  cache hits: ${r.totals.cacheHits}  unjudged: ${r.totals.unjudged}  denylisted: ${r.totals.denylisted}`);
  console.log(`  duplicate pairs confirmed: ${r.duplicatePairs.length}  exact-duplicate clusters: ${r.exactDuplicateClusters.length}`);

  if (args.gate) {
    const gateResult = evaluateGate(result.report, config.thresholds, { jevUnavailable: result.jevUnavailable });
    console.log(`\n${formatGateReport(gateResult)}`);
    if (!gateResult.ok) process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
