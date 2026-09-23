#!/usr/bin/env node
/**
 * The quality GATE: takes a report already produced by `runAudit` (mode
 * "changed") and decides which changed/edited functions trip a BLOCKING
 * rule. Kept as a separate module from run.mjs so both the plugin's own
 * `--gate` CLI mode and MapleLens's mission-loop QUALITY stage can call
 * `evaluateGate()` directly against an in-memory report — no CLI
 * round-trip needed from the loop.
 *
 * FAIL-OPEN/CLOSED ASYMMETRY (matches MapleLens's tools/jev/gate.mjs house
 * style): rule 1 (exact duplicate) is deterministic — computed locally from
 * a body-hash match, never from a Jev call — so it fails CLOSED: if the
 * report ran at all, this rule's verdict is always trustworthy. Rules 2-5
 * depend on a Jev-scored function; when the audit ran with no usable Jev
 * answers at all (`jevUnavailable: true`, set by the caller when every
 * evaluate() call in the run failed/was skipped), those four rules are
 * simply not evaluated and the gate prints a loud one-line notice — it
 * NEVER blocks on a rule it could not actually check.
 *
 * Sensitive (denylisted) functions never reach here with real content:
 * `runAudit` never calls evaluateFn on them, and the report lists them
 * under `notAudited` — this module treats every id in `notAudited` as
 * "not audited (sensitive)" and never blocks on it.
 */

export const RULE_IDS = /** @type {const} */ ({
  EXACT_DUPLICATE: "exact-duplicate",
  NEAR_DUPLICATE: "near-duplicate",
  SECURITY: "security",
  ERROR_HANDLING: "error-handling",
  EFFICIENCY: "efficiency",
});

/** Human-readable rule descriptions, reused verbatim in gate output and in the MapleLens loop's worker feedback (never model prose — see the loop stage doc). */
export const RULE_TEXT = {
  [RULE_IDS.EXACT_DUPLICATE]: "exact duplicate of an existing function (same normalized body) — reuse the existing copy instead of adding a new one",
  [RULE_IDS.NEAR_DUPLICATE]: "near-duplicate of an existing function, confirmed by Jev — reuse or consolidate instead of adding a new one",
  [RULE_IDS.SECURITY]: "security risk scored Serious or worse with high confidence — injection, unsafe eval/HTML, secret exposure, or an unvalidated input reaching a sink",
  [RULE_IDS.ERROR_HANDLING]: "this function can fail but does not visibly handle errors (no throw/return/log, and no documented best-effort fallback)",
  [RULE_IDS.EFFICIENCY]: "efficiency scored Wasteful or worse — repeated I/O, N+1 queries, needless loops/allocations, or a blocking call on a hot path",
};

/**
 * @param {object} fn  a report.worstFirst-shaped function record (has .scores, .confidences, .deliberateBestEffort, .suppressions, .lineCount)
 * @param {{exactDuplicateClusters:Array, duplicatePairs:Array}} report
 * @param {object} thresholds  see audit/config.mjs DEFAULT_THRESHOLDS
 * @returns {Array<{rule:string, message:string, blocking:boolean, suppressed:boolean, reason?:string}>}
 */
export function evaluateFunction(fn, report, thresholds) {
  const findings = [];
  const suppressions = fn.suppressions ?? {};

  function push(rule, message, tripped) {
    if (!tripped) return;
    const suppressed = Object.prototype.hasOwnProperty.call(suppressions, rule);
    findings.push({
      rule,
      message,
      blocking: !suppressed,
      suppressed,
      reason: suppressed ? suppressions[rule] : undefined,
    });
  }

  // ── Rule 1: exact duplicate (deterministic, fails CLOSED) ──
  const cluster = (report.exactDuplicateClusters ?? []).find((c) => c.memberIds.includes(fn.id));
  if (cluster) {
    const other = cluster.memberIds.find((id) => id !== fn.id);
    push(
      RULE_IDS.EXACT_DUPLICATE,
      `${RULE_TEXT[RULE_IDS.EXACT_DUPLICATE]} — reuse ${other ?? "(cluster member)"}`,
      Boolean(other),
    );
  }

  if (fn.unjudged || !fn.scores) return findings; // nothing further can be checked without a Jev score

  // ── Rule 2: near-duplicate confirmed by Jev with p >= threshold ──
  const confirmedPair = (report.duplicatePairs ?? []).find(
    (p) => (p.aId === fn.id || p.bId === fn.id) && typeof p.sameJobProbability === "number" && p.sameJobProbability >= thresholds.nearDuplicateProbability,
  );
  if (confirmedPair) {
    const other = confirmedPair.aId === fn.id ? confirmedPair.bId : confirmedPair.aId;
    push(RULE_IDS.NEAR_DUPLICATE, `${RULE_TEXT[RULE_IDS.NEAR_DUPLICATE]} (p=${confirmedPair.sameJobProbability.toFixed(2)}) — see ${other}`, true);
  }

  // ── Rule 3: security ──
  const s = fn.scores;
  const c = fn.confidences ?? {};
  push(
    RULE_IDS.SECURITY,
    `${RULE_TEXT[RULE_IDS.SECURITY]} (score=${s.security}, confidence=${(c.security ?? 1).toFixed(2)})`,
    typeof s.security === "number" && s.security >= thresholds.securityScoreFloor && (c.security ?? 1) >= thresholds.securityConfidenceFloor,
  );

  // ── Rule 4: can_fail high, error_handling low, not a deliberate best-effort catch ──
  const canFail = typeof s.can_fail === "number" ? s.can_fail : 1; // no can_fail on a legacy cache entry -> assume it can fail (safe direction)
  push(
    RULE_IDS.ERROR_HANDLING,
    `${RULE_TEXT[RULE_IDS.ERROR_HANDLING]} (can_fail=${canFail.toFixed(2)}, error_handling=${(s.error_handling ?? 0).toFixed(2)})`,
    canFail >= thresholds.canFailFloor && typeof s.error_handling === "number" && s.error_handling < thresholds.errorHandlingCeiling && !fn.deliberateBestEffort,
  );

  // ── Rule 5: efficiency ──
  push(RULE_IDS.EFFICIENCY, `${RULE_TEXT[RULE_IDS.EFFICIENCY]} (score=${s.efficiency})`, typeof s.efficiency === "number" && s.efficiency >= thresholds.efficiencyScoreFloor);

  return findings;
}

/**
 * @param {object} report  the object `buildReport` returns (audit/report.mjs)
 * @param {object} thresholds
 * @param {boolean} jevUnavailable  true when the run made zero successful Jev calls it needed (see run.mjs) — every Jev-dependent rule is skipped, loudly
 * @returns {{
 *   ok: boolean,
 *   blockingFindings: Array<{id:string,file:string,startLine:number,rule:string,message:string}>,
 *   warnings: Array<{id:string,file:string,startLine:number,rule:string,message:string}>,
 *   suppressions: Array<{id:string,file:string,startLine:number,rule:string,reason:string}>,
 *   notAudited: string[],
 *   jevUnavailable: boolean,
 * }}
 */
export function evaluateGate(report, thresholds, { jevUnavailable = false } = {}) {
  const blockingFindings = [];
  const warnings = [];
  const suppressions = [];

  for (const fn of report.worstFirst ?? []) {
    const findings = evaluateFunction(fn, report, thresholds);
    for (const f of findings) {
      const entry = { id: fn.id, file: fn.file, startLine: fn.startLine, rule: f.rule, message: f.message };
      if (f.suppressed) {
        suppressions.push({ ...entry, reason: f.reason });
      } else if (f.rule === RULE_IDS.EXACT_DUPLICATE) {
        // Deterministic — always evaluated and always blocking, Jev or no Jev.
        blockingFindings.push(entry);
      } else if (jevUnavailable) {
        // Jev-dependent rule, but this run has no usable Jev answers — never block on a rule that could not be checked.
        continue;
      } else if (f.blocking) {
        blockingFindings.push(entry);
      } else {
        warnings.push(entry);
      }
    }
  }

  return {
    ok: blockingFindings.length === 0,
    blockingFindings,
    warnings,
    suppressions,
    notAudited: report.notAudited ?? [],
    jevUnavailable,
  };
}

/** Plain-language console report — used by the CLI's `--gate` mode and mirrored (rule text + function/file/line only, never prose) by the MapleLens loop stage's feedback to the worker. */
export function formatGateReport(result) {
  const lines = [];
  if (result.jevUnavailable) {
    lines.push("quality gate: Jev unavailable, only deterministic checks ran");
  }
  if (result.blockingFindings.length === 0) {
    lines.push(result.ok ? "quality gate: passed" : "quality gate: passed (no blocking findings)");
  } else {
    lines.push(`quality gate: FAILED — ${result.blockingFindings.length} blocking finding(s)`);
    for (const f of result.blockingFindings) {
      lines.push(`  [${f.rule}] ${f.file}:${f.startLine} ${f.id}`);
      lines.push(`    ${f.message}`);
    }
  }
  if (result.warnings.length > 0) {
    lines.push(`warnings (non-blocking, ${result.warnings.length}):`);
    for (const f of result.warnings) lines.push(`  [${f.rule}] ${f.file}:${f.startLine} ${f.id} — ${f.message}`);
  }
  if (result.suppressions.length > 0) {
    lines.push(`accepted suppressions (${result.suppressions.length}):`);
    for (const s of result.suppressions) lines.push(`  [${s.rule}] ${s.file}:${s.startLine} ${s.id} — ${s.reason}`);
  }
  if (result.notAudited.length > 0) {
    lines.push(`not audited (sensitive, ${result.notAudited.length}): ${result.notAudited.join(", ")}`);
  }
  return lines.join("\n");
}
