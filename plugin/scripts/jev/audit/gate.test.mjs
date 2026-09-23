import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_THRESHOLDS } from "./config.mjs";
import { evaluateFunction, evaluateGate, formatGateReport, RULE_IDS } from "./gate.mjs";

function fn(overrides = {}) {
  return {
    id: "src/foo.ts#doThing",
    file: "src/foo.ts",
    startLine: 10,
    endLine: 20,
    scores: { security: 0, efficiency: 0, clarity: 0, error_handling: 1, edge_cases: 1, can_fail: 1 },
    confidences: { security: 1, efficiency: 1, clarity: 1, error_handling: 1, edge_cases: 1 },
    deliberateBestEffort: false,
    suppressions: {},
    ...overrides,
  };
}

const emptyReport = { exactDuplicateClusters: [], duplicatePairs: [], worstFirst: [], notAudited: [] };

test("rule 1: exact duplicate blocks and names the existing copy", () => {
  const report = { ...emptyReport, exactDuplicateClusters: [{ bodyHash: "h", memberIds: ["src/foo.ts#doThing", "src/bar.ts#doThingElse"] }] };
  const findings = evaluateFunction(fn(), report, DEFAULT_THRESHOLDS);
  const f = findings.find((x) => x.rule === RULE_IDS.EXACT_DUPLICATE);
  assert.ok(f);
  assert.equal(f.blocking, true);
  assert.match(f.message, /src\/bar\.ts#doThingElse/);
});

test("rule 2: near-duplicate confirmed by Jev at p >= 0.9 blocks", () => {
  const report = { ...emptyReport, duplicatePairs: [{ aId: "src/foo.ts#doThing", bId: "src/bar.ts#other", sameJobProbability: 0.95 }] };
  const findings = evaluateFunction(fn(), report, DEFAULT_THRESHOLDS);
  const f = findings.find((x) => x.rule === RULE_IDS.NEAR_DUPLICATE);
  assert.ok(f);
  assert.equal(f.blocking, true);
});

test("rule 2: a near-duplicate below the probability floor does not block", () => {
  const report = { ...emptyReport, duplicatePairs: [{ aId: "src/foo.ts#doThing", bId: "src/bar.ts#other", sameJobProbability: 0.5 }] };
  const findings = evaluateFunction(fn(), report, DEFAULT_THRESHOLDS);
  assert.equal(findings.find((x) => x.rule === RULE_IDS.NEAR_DUPLICATE), undefined);
});

test("rule 3: security >= 3 with confidence >= 0.6 blocks", () => {
  const f = fn({ scores: { security: 3, efficiency: 0, clarity: 0, error_handling: 1, edge_cases: 1, can_fail: 1 }, confidences: { security: 0.8 } });
  const findings = evaluateFunction(f, emptyReport, DEFAULT_THRESHOLDS);
  const finding = findings.find((x) => x.rule === RULE_IDS.SECURITY);
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test("rule 3: a serious security score with low confidence does not block", () => {
  const f = fn({ scores: { security: 3, efficiency: 0, clarity: 0, error_handling: 1, edge_cases: 1, can_fail: 1 }, confidences: { security: 0.3 } });
  const findings = evaluateFunction(f, emptyReport, DEFAULT_THRESHOLDS);
  assert.equal(findings.find((x) => x.rule === RULE_IDS.SECURITY), undefined);
});

test("rule 4: can_fail high + error_handling low + not deliberate best-effort blocks", () => {
  const f = fn({ scores: { security: 0, efficiency: 0, clarity: 0, error_handling: 0.1, edge_cases: 1, can_fail: 0.9 } });
  const findings = evaluateFunction(f, emptyReport, DEFAULT_THRESHOLDS);
  const finding = findings.find((x) => x.rule === RULE_IDS.ERROR_HANDLING);
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test("rule 4: a deliberate best-effort catch is exempt", () => {
  const f = fn({ scores: { security: 0, efficiency: 0, clarity: 0, error_handling: 0.1, edge_cases: 1, can_fail: 0.9 }, deliberateBestEffort: true });
  const findings = evaluateFunction(f, emptyReport, DEFAULT_THRESHOLDS);
  assert.equal(findings.find((x) => x.rule === RULE_IDS.ERROR_HANDLING), undefined);
});

test("rule 4: a pure function (can_fail low) is not penalized for 'bad' error handling", () => {
  const f = fn({ scores: { security: 0, efficiency: 0, clarity: 0, error_handling: 0.0, edge_cases: 1, can_fail: 0.1 } });
  const findings = evaluateFunction(f, emptyReport, DEFAULT_THRESHOLDS);
  assert.equal(findings.find((x) => x.rule === RULE_IDS.ERROR_HANDLING), undefined);
});

test("rule 5: efficiency >= 3 blocks", () => {
  const f = fn({ scores: { security: 0, efficiency: 3, clarity: 0, error_handling: 1, edge_cases: 1, can_fail: 1 } });
  const findings = evaluateFunction(f, emptyReport, DEFAULT_THRESHOLDS);
  const finding = findings.find((x) => x.rule === RULE_IDS.EFFICIENCY);
  assert.ok(finding);
  assert.equal(finding.blocking, true);
});

test("a clean function trips nothing", () => {
  const findings = evaluateFunction(fn(), emptyReport, DEFAULT_THRESHOLDS);
  assert.deepEqual(findings, []);
});

test("an accept comment suppresses that rule and is listed, not blocking", () => {
  const f = fn({
    scores: { security: 4, efficiency: 0, clarity: 0, error_handling: 1, edge_cases: 1, can_fail: 1 },
    confidences: { security: 1 },
    suppressions: { security: "reviewed — input is already sanitized upstream" },
  });
  const findings = evaluateFunction(f, emptyReport, DEFAULT_THRESHOLDS);
  const finding = findings.find((x) => x.rule === RULE_IDS.SECURITY);
  assert.ok(finding);
  assert.equal(finding.blocking, false);
  assert.equal(finding.suppressed, true);
  assert.equal(finding.reason, "reviewed — input is already sanitized upstream");
});

test("evaluateGate: a suppressed finding is listed under suppressions, not blockingFindings", () => {
  const f = fn({
    scores: { security: 4, efficiency: 0, clarity: 0, error_handling: 1, edge_cases: 1, can_fail: 1 },
    confidences: { security: 1 },
    suppressions: { security: "accepted risk" },
  });
  const report = { ...emptyReport, worstFirst: [f] };
  const result = evaluateGate(report, DEFAULT_THRESHOLDS);
  assert.equal(result.ok, true);
  assert.equal(result.blockingFindings.length, 0);
  assert.equal(result.suppressions.length, 1);
  assert.equal(result.suppressions[0].reason, "accepted risk");
});

test("evaluateGate: unjudged/denylisted functions never block", () => {
  const denylisted = fn({ id: "src/creds.ts#login", scores: undefined, unjudged: false });
  const report = { ...emptyReport, worstFirst: [{ ...denylisted, scores: undefined }], notAudited: ["src/creds.ts#login"] };
  const result = evaluateGate(report, DEFAULT_THRESHOLDS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.notAudited, ["src/creds.ts#login"]);
});

test("evaluateGate: rule 1 (exact duplicate) still blocks even when Jev is unavailable", () => {
  const report = { ...emptyReport, exactDuplicateClusters: [{ bodyHash: "h", memberIds: ["src/foo.ts#doThing", "src/bar.ts#other"] }], worstFirst: [fn({ unjudged: true, scores: undefined })] };
  const result = evaluateGate(report, DEFAULT_THRESHOLDS, { jevUnavailable: true });
  assert.equal(result.ok, false);
  assert.equal(result.blockingFindings.length, 1);
  assert.equal(result.blockingFindings[0].rule, RULE_IDS.EXACT_DUPLICATE);
});

test("evaluateGate: Jev-dependent rules never block when Jev was unavailable", () => {
  const f = fn({ scores: { security: 4, efficiency: 4, clarity: 0, error_handling: 0, edge_cases: 1, can_fail: 1 }, confidences: { security: 1 } });
  const report = { ...emptyReport, worstFirst: [f] };
  const result = evaluateGate(report, DEFAULT_THRESHOLDS, { jevUnavailable: true });
  assert.equal(result.ok, true);
  assert.equal(result.blockingFindings.length, 0);
  assert.equal(result.jevUnavailable, true);
});

test("formatGateReport prints the Jev-unavailable notice, blocking findings, warnings, and suppressions", () => {
  const result = {
    ok: false,
    jevUnavailable: true,
    blockingFindings: [{ id: "a#b", file: "a.ts", startLine: 1, rule: RULE_IDS.EXACT_DUPLICATE, message: "dup" }],
    warnings: [{ id: "c#d", file: "c.ts", startLine: 2, rule: RULE_IDS.EFFICIENCY, message: "slow" }],
    suppressions: [{ id: "e#f", file: "e.ts", startLine: 3, rule: RULE_IDS.SECURITY, reason: "reviewed" }],
    notAudited: ["g.ts#h"],
  };
  const text = formatGateReport(result);
  assert.match(text, /Jev unavailable/);
  assert.match(text, /FAILED/);
  assert.match(text, /a\.ts:1/);
  assert.match(text, /warnings/);
  assert.match(text, /suppressions/);
  assert.match(text, /not audited/);
});
