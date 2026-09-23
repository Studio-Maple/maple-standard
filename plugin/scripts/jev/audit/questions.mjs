import { createHash } from "node:crypto";

/**
 * The typed questions tools/jev/audit.mjs asks Jev about each function, and
 * the deterministic pieces that go alongside them (severity rollup,
 * "has a test" detection). Kept in one exported object/module, per the
 * house style in judge.mjs and supervise.mjs, so the rubric and thresholds
 * are tunable in one place instead of scattered through the CLI.
 *
 * As in judge.mjs/supervise.mjs: everything about the function under review
 * (its source, imports, name) belongs in the `state` passed to `evaluate`,
 * never folded into these `instructions` strings — the instructions are the
 * only trusted text, and Jev's answer shape comes from these definitions, so
 * nothing in a function's source can rewrite what's being asked.
 */

/** One `evaluate()` call's worth of questions for a single function. */
export const FUNCTION_QUESTIONS = {
  security: {
    type: "score",
    instructions:
      "Rate the security risk of this function's own logic: injection, command/shell construction, unvalidated external input reaching a sink, secret exposure, unsafe eval/HTML construction.",
    criteria: ["No issue", "Minor", "Moderate", "Serious", "Critical"],
  },
  error_handling: {
    type: "noul",
    instructions:
      "Are errors in this function handled with SOME visible signal, rather than silently swallowed? Count it as handled if errors are thrown, returned, or logged — AND ALSO count it as handled if a failure is deliberately and visibly caught with a documented fallback: a comment explaining why the failure is ignored, or a logged/returned fallback value showing the catch was intentional best-effort handling, not an oversight. Only answer false when a failure disappears with no signal at all: no throw, no log, no comment, no returned indication anything went wrong.",
    criteria: {
      true: "Errors are thrown, returned, logged, or deliberately handled with a documented/visible best-effort fallback",
      false: "A failure is silently swallowed with no log, comment, or returned signal explaining why",
    },
  },
  efficiency: {
    type: "score",
    instructions:
      "Rate this function's efficiency: repeated I/O, N+1 queries, needless loops or allocations, blocking calls on a hot path.",
    criteria: ["Efficient", "Minor waste", "Noticeable", "Wasteful", "Pathological"],
  },
  edge_cases: {
    type: "noul",
    instructions: "Does this function handle null/undefined, empty, and boundary inputs rather than assuming well-formed input?",
    criteria: {
      true: "Boundary and missing-input cases are visibly considered",
      false: "The function assumes well-formed input and would misbehave on edge cases",
    },
  },
  clarity: {
    type: "score",
    instructions: "Rate how easy this function is to read and maintain.",
    criteria: ["Clear", "Mostly clear", "Tangled", "Hard to follow", "Unmaintainable"],
  },
  // The EasyCaller run flagged 673 functions on error_handling/edge_cases,
  // led by pure code like a G.711 byte decoder: a noul has no "not
  // applicable", so a function with nothing that can fail still reads as
  // "doesn't handle failures". This asks the applicability question
  // separately; computeSeverity scales both dimensions by it.
  can_fail: {
    type: "noul",
    instructions:
      "Can this function fail or receive input it does not control? Count I/O, network or database calls, parsing, user or external input, and calls that can throw or reject. A pure computation over values its caller already validated cannot fail in this sense.",
    criteria: {
      true: "It does I/O, parses, calls something that can throw or reject, or takes uncontrolled input",
      false: "It is a pure computation or a thin wrapper with no failure paths of its own",
    },
  },
};

/** The one duplication question, asked per candidate pair — see audit-fingerprint.mjs for how pairs are chosen. */
export const DUPLICATE_QUESTION = {
  same_job: {
    type: "noul",
    instructions: "Do these two functions do the same job, such that one could replace the other?",
    criteria: {
      true: "They accomplish the same task and one could substitute for the other",
      false: "They differ in purpose, behaviour, or contract even if superficially similar",
    },
  },
};

/**
 * SHA-256 of the two question definitions above, hex-encoded. Folded into
 * the cache key in audit.mjs (see `cacheKeyFor`) so that changing a
 * question's wording — like the error_handling reword above, done because
 * the MapleLens pilot flagged 383 functions on it, mostly deliberate
 * best-effort handling — invalidates every cached answer instead of quietly
 * serving scores that were computed against the OLD question text. A stale
 * hit here would be worse than a cache miss: it would look like a fresh,
 * correct answer to the new question when it never saw it.
 */
export const QUESTIONS_VERSION = createHash("sha256")
  .update(JSON.stringify({ FUNCTION_QUESTIONS, DUPLICATE_QUESTION }))
  .digest("hex")
  .slice(0, 16);

/**
 * A `*.test.*` file referencing the bare function name is treated as "has a
 * test" — cheap and deterministic, so it is never asked of Jev (a model
 * would have to re-derive this from the same grep anyway, at API cost).
 * False positives exist (a common name like `run` matching an unrelated
 * test) — traded for zero API calls on a fact code search already answers.
 */
export function hasTestReference(functionName, testFileContents) {
  if (!functionName || functionName.startsWith("(")) return false; // anonymous — nothing to grep for
  const re = new RegExp(`\\b${functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  return testFileContents.some((text) => re.test(text));
}

/**
 * SEVERITY FORMULA — documented here because it is a judgment call, not a
 * derivation. Higher = worse, range [0, 10].
 *
 * v1 of this formula (plain weighted sum, security doubled) let a single
 * confidently-scored dimension dominate: a function that merely builds a SQL
 * string or spawns a process would get a "Moderate" security score and float
 * to the top of the list on that one dimension alone, even when every other
 * dimension was clean — while a function that was mediocre across several
 * dimensions at once (the more genuinely worrying shape) ranked lower. v2
 * fixes both problems at once:
 *
 * 1. Each dimension's badness is normalized to 0..1 first:
 *      score dimensions (security/efficiency/clarity, 0..4)  -> score / 4
 *      noul dimensions (error_handling/edge_cases, P(good))  -> 1 - p
 *
 * 2. Each normalized badness is weighted by that dimension's own confidence
 *    (0..1) before combining, when Jev supplies one. A "Moderate" security
 *    score Jev is only 30% sure about should not carry the same weight as a
 *    "Moderate" it is 95% sure about. Jev's noul answers do not carry a
 *    separate confidence (see client.mjs's `likely()` doc comment — a noul
 *    IS a probability), so a missing confidence defaults to 1 (full weight),
 *    which also keeps this backward-compatible with any caller that doesn't
 *    pass `confidences` at all.
 *
 * 3. The weighted badnesses are combined as a weighted quadratic mean
 *    (root-sum-of-squares, normalized by the root-sum-of-squares of the
 *    weights alone) rather than a plain sum. This is the piece that actually
 *    solves "one moderate dimension shouldn't beat several": squaring before
 *    summing means one dimension at full weighted badness caps out well
 *    below the maximum (a lone maxed-out `security` cannot exceed ~6.2 of
 *    10), while the SAME total badness spread across multiple dimensions
 *    scores higher (five dimensions all at 0.5 badness score 5.0) — a
 *    function that's bad in several ways outranks one that's bad in exactly
 *    one way, even a heavily-weighted one.
 *
 * SEVERITY_WEIGHTS keeps security weighted highest (it is still a
 * qualitatively worse class of problem, and this list exists to triage
 * attention, not to average unlike things evenly) but no longer lets it
 * dominate on its own: security's per-dimension weight is 1.5 against
 * 0.75-1.25 for the rest, not the old flat x2/x1 split.
 *
 * Unjudged functions (any dimension null/undefined) get severity `null` and
 * sort last, not zero — zero would hide them as "fine".
 *
 * A function flagged `deliberate_best_effort` (see
 * `hasDeliberateBestEffortCatch` in audit-extract.mjs) gets its
 * error_handling badness forced to 0 — a documented best-effort swallow is
 * not the same defect this dimension exists to catch — but the function is
 * still listed separately in the report (see `buildReport` in
 * audit-report.mjs) so the exemption stays visible, not silent.
 *
 * 4. SMALL-FUNCTION SECURITY DAMPENER. The MapleLens pilot's top of the list
 *    was dominated by tiny functions that merely build a SQL string or spawn
 *    a process — `buildUptime24hSql` interpolates a CONSTANT table name, a
 *    false positive, but a few lines of "builds SQL" is enough for Jev to
 *    hand out a real security score with real confidence, and neither
 *    normalization nor confidence-weighting above touches that: the model
 *    was confident, just wrong about the context. A function under
 *    `SMALL_FN_LINE_THRESHOLD` lines is too small to show the surrounding
 *    context (who calls it, whether its inputs are already trusted) that
 *    security risk actually depends on, so its security weight is dampened
 *    UNLESS the score is already high enough (>= `SMALL_FN_SECURITY_FLOOR`)
 *    that dampening a real finding would be worse than tolerating a few
 *    false positives in short functions — a real "Serious"/"Critical" in ten
 *    lines is still a real "Serious"/"Critical".
 *
 * 5. APPLICABILITY. error_handling and edge_cases badness is multiplied by
 *    `scores.can_fail` (P(the function can fail at all)), so a pure
 *    function's "doesn't handle failures" costs nothing. Entries without
 *    `can_fail` (older caches) are unscaled.
 *
 * This is UNCALIBRATED: nobody has yet checked that a severity of 6 reliably
 * looks worse than a 4 across a sample of real functions (see the pilot run
 * in AUDIT.md). Revisit the weights once real audits accumulate, and prefer
 * changing the constants below over changing the shape.
 */
export const SEVERITY_WEIGHTS = {
  security: 1.5,
  efficiency: 0.75,
  clarity: 0.75,
  error_handling: 1.25,
  edge_cases: 1.0,
};

/** Below this line count, security's weight is dampened (see point 4 above) unless the score already clears SMALL_FN_SECURITY_FLOOR. Env-overridable like the other tuning constants in this house style. */
export const SMALL_FN_LINE_THRESHOLD = Number(process.env.MAPLE_QUALITY_AUDIT_SMALL_FN_LINE_THRESHOLD || 8);
/** A security score at or above this (out of 4) is trusted at full weight even in a small function — a real finding, not noise. */
export const SMALL_FN_SECURITY_FLOOR = Number(process.env.MAPLE_QUALITY_AUDIT_SMALL_FN_SECURITY_FLOOR || 3);
/** How much a small function's security weight is scaled by when dampened. */
export const SMALL_FN_SECURITY_DAMPENER = Number(process.env.MAPLE_QUALITY_AUDIT_SMALL_FN_SECURITY_DAMPENER || 0.6);

const SEVERITY_DIMENSIONS = Object.keys(SEVERITY_WEIGHTS);
const WEIGHT_SUM_SQUARES = SEVERITY_DIMENSIONS.reduce((sum, dim) => sum + SEVERITY_WEIGHTS[dim] ** 2, 0);

/** Normalize a raw score/noul value for one dimension to a 0..1 "how bad" value. */
function badnessOf(dimension, value) {
  if (dimension === "error_handling" || dimension === "edge_cases") return 1 - value; // noul is P(good)
  return value / 4; // score dimensions run 0..4
}

/**
 * @param {{security:number, efficiency:number, clarity:number, error_handling:number, edge_cases:number}} scores
 * @param {{security?:number, efficiency?:number, clarity?:number, error_handling?:number, edge_cases?:number}} [confidences]
 *   Per-dimension confidence (0..1). A missing entry defaults to 1 (full weight) — this is
 *   both how noul dimensions behave (see doc comment above) and how any older caller that
 *   doesn't pass confidences at all keeps working unchanged.
 * @param {{deliberateBestEffort?: boolean, lineCount?: number}} [opts]
 *   `deliberateBestEffort: true` zeroes out error_handling badness (point 3 above).
 *   `lineCount` under SMALL_FN_LINE_THRESHOLD dampens security's weight (point 4 above)
 *   unless the security score already clears SMALL_FN_SECURITY_FLOOR. Omitting `lineCount`
 *   (e.g. an older cache entry that never recorded it) means no dampening — the safe
 *   direction, since it costs the function scrutiny rather than hiding a real finding.
 */
export function computeSeverity(scores, confidences = {}, opts = {}) {
  if (!scores) return null;
  if (SEVERITY_DIMENSIONS.some((dim) => scores[dim] === null || scores[dim] === undefined)) return null;

  const isSmall = typeof opts.lineCount === "number" && opts.lineCount < SMALL_FN_LINE_THRESHOLD;
  const dampenSecurity = isSmall && scores.security < SMALL_FN_SECURITY_FLOOR;

  let sumSquares = 0;
  for (const dim of SEVERITY_DIMENSIONS) {
    let weight = SEVERITY_WEIGHTS[dim];
    if (dim === "security" && dampenSecurity) weight *= SMALL_FN_SECURITY_DAMPENER;
    const confidence = confidences?.[dim] ?? 1;
    let badness = dim === "error_handling" && opts.deliberateBestEffort ? 0 : badnessOf(dim, scores[dim]);
    // Point 5: failure-handling dimensions only count as much as the function
    // can fail. A cache entry from before `can_fail` existed has none, and is
    // scored exactly as before (factor 1).
    if ((dim === "error_handling" || dim === "edge_cases") && typeof scores.can_fail === "number") {
      badness *= scores.can_fail;
    }
    const weighted = weight * confidence * badness;
    sumSquares += weighted * weighted;
  }
  return 10 * Math.sqrt(sumSquares / WEIGHT_SUM_SQUARES);
}

/** Above this severity AND untested, a function goes on the "untested and risky" list. Uncalibrated — env-overridable like the thresholds in judge.mjs/supervise.mjs. */
export const RISKY_SEVERITY_FLOOR = Number(process.env.MAPLE_QUALITY_AUDIT_RISKY_SEVERITY_FLOOR || 5);
