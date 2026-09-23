/**
 * Severity rollup and the deterministic test-reference check —
 * tools/jev/audit-questions.mjs.
 *
 *   node --test tools/jev/audit-questions.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { SEVERITY_WEIGHTS, computeSeverity, hasTestReference } from "./questions.mjs";

const WEIGHT_SUM_SQUARES = Object.values(SEVERITY_WEIGHTS).reduce((s, w) => s + w * w, 0);

test("computeSeverity: a clean function scores 0", () => {
  // security 0 (No issue), efficiency 0, clarity 0, error_handling 1 (always handled), edge_cases 1 -> every badness is 0
  const severity = computeSeverity({ security: 0, efficiency: 0, clarity: 0, error_handling: 1, edge_cases: 1 });
  assert.equal(severity, 0);
});

test("computeSeverity: a maxed-out single dimension cannot reach the ceiling alone", () => {
  // security=4 (Critical) is full badness (1.0) on its own weight (1.5); every other dimension is clean.
  // This is the "one moderate/critical dimension shouldn't dominate" property: even the worst possible
  // reading of the single highest-weighted dimension stays well under the 10 ceiling.
  const severity = computeSeverity({ security: 4, efficiency: 0, clarity: 0, error_handling: 1, edge_cases: 1 });
  const expected = 10 * Math.sqrt((SEVERITY_WEIGHTS.security ** 2) / WEIGHT_SUM_SQUARES);
  assert.equal(Math.round(severity * 100) / 100, Math.round(expected * 100) / 100);
  assert.ok(severity < 10);
});

test("computeSeverity: several moderately-bad dimensions outrank one moderately-bad dimension", () => {
  // Five dimensions each at 0.5 badness (score=2/4, or noul=0.5) vs. security alone at 0.5 badness (score=2/4).
  const severityAllModerate = computeSeverity({ security: 2, efficiency: 2, clarity: 2, error_handling: 0.5, edge_cases: 0.5 });
  const severitySecurityOnlyModerate = computeSeverity({ security: 2, efficiency: 0, clarity: 0, error_handling: 1, edge_cases: 1 });
  assert.ok(
    severityAllModerate > severitySecurityOnlyModerate,
    `expected bad-in-several-ways (${severityAllModerate}) to outrank bad-in-one-way (${severitySecurityOnlyModerate})`,
  );
});

test("computeSeverity: a low-confidence score contributes less than a high-confidence one", () => {
  const confident = computeSeverity({ security: 2, efficiency: 0, clarity: 0, error_handling: 1, edge_cases: 1 }, { security: 0.95 });
  const unsure = computeSeverity({ security: 2, efficiency: 0, clarity: 0, error_handling: 1, edge_cases: 1 }, { security: 0.2 });
  assert.ok(unsure < confident);
});

test("computeSeverity: missing confidence defaults to full weight (backward compatible)", () => {
  const withoutConfidence = computeSeverity({ security: 2, efficiency: 1, clarity: 1, error_handling: 0.8, edge_cases: 0.9 });
  const withFullConfidence = computeSeverity(
    { security: 2, efficiency: 1, clarity: 1, error_handling: 0.8, edge_cases: 0.9 },
    { security: 1, efficiency: 1, clarity: 1 },
  );
  assert.equal(withoutConfidence, withFullConfidence);
});

test("computeSeverity: deliberateBestEffort zeroes out the error_handling contribution", () => {
  const scores = { security: 0, efficiency: 0, clarity: 0, error_handling: 0, edge_cases: 1 }; // error_handling fully bad
  const withoutExemption = computeSeverity(scores);
  const withExemption = computeSeverity(scores, {}, { deliberateBestEffort: true });
  assert.ok(withoutExemption > 0);
  assert.equal(withExemption, 0);
});

test("computeSeverity returns null when any dimension is missing (unjudged)", () => {
  assert.equal(computeSeverity(null), null);
  assert.equal(computeSeverity({ security: 1, efficiency: 1, clarity: 1, error_handling: null, edge_cases: 1 }), null);
});

test("hasTestReference finds a bare-word match in a test file's contents", () => {
  const tests = ["import { computeSeverity } from './questions.mjs';\ntest('x', () => computeSeverity({}));"];
  assert.ok(hasTestReference("computeSeverity", tests));
  assert.ok(!hasTestReference("someOtherFunction", tests));
});

test("hasTestReference does not false-positive on a substring of a longer identifier", () => {
  const tests = ["computeSeverityForBatch(x)"];
  assert.ok(!hasTestReference("computeSeverity", tests));
});

test("hasTestReference is false for anonymous functions (nothing to search for)", () => {
  assert.ok(!hasTestReference("(anonymous)", ["computeSeverity()"]));
});

test("can_fail scales error_handling and edge_cases badness; absent can_fail leaves them unscaled", () => {
  const base = { security: 0, efficiency: 0, clarity: 0, error_handling: 0.05, edge_cases: 0.05 };
  const legacy = computeSeverity(base);
  const pure = computeSeverity({ ...base, can_fail: 0.02 });
  const risky = computeSeverity({ ...base, can_fail: 1 });
  assert.ok(pure < legacy / 10, "a pure function is not penalised for failures it cannot have");
  assert.equal(risky, legacy, "can_fail = 1 is the old behaviour");
});
