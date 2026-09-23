import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { resolveBaseBranch, runAudit } from "./run.mjs";
import { DEFAULT_THRESHOLDS } from "./config.mjs";
import { evaluateGate } from "./gate.mjs";

const CONFIG = {
  scopeDirs: ["src"],
  extensions: [".ts"],
  excludeGlobs: [],
  denylistPatterns: ["secret"],
  denylistFiles: [],
  denylistDirs: [],
  moduleLabels: {},
  trivialMaxStatements: 3,
  trivialMaxLines: 4,
  maxSourceBytes: 6144,
  shingleSize: 5,
  jaccardThreshold: 0.6,
  jevPairCap: 200,
};

function fakeFiles(map) {
  const readFileFn = async (p) => {
    const rel = path.relative("/repo", p).replace(/\\/g, "/");
    if (rel in map) return map[rel];
    const err = new Error("ENOENT");
    err.code = "ENOENT";
    throw err;
  };
  return readFileFn;
}

const CHANGED_SRC = `
export function riskyEval(input) {
  const trimmed = String(input).trim();
  const evaluated = eval(trimmed);
  return evaluated;
}
`;

test("runAudit (changed mode): extracts changed functions and calls evaluateFn for each", async () => {
  const files = { "src/a.ts": CHANGED_SRC };
  const evaluateFn = async (state) => ({
    answers: {
      security: { score: 1, confidence: 0.9 },
      efficiency: { score: 0, confidence: 0.9 },
      clarity: { score: 0, confidence: 0.9 },
      error_handling: { noul: 0.9, confidence: 0.9 },
      edge_cases: { noul: 0.9, confidence: 0.9 },
      can_fail: { noul: 0.9 },
    },
    usage: { calls: 1 },
  });
  const result = await runAudit({
    cwd: "/repo",
    config: CONFIG,
    mode: "changed",
    baseBranch: "main",
    readFileFn: fakeFiles(files),
    discoverChangedFilesFn: async () => ["src/a.ts"],
    discoverAllFilesFn: async () => ["src/a.ts"],
    discoverTestFilesFn: async () => [],
    evaluateFn,
  });
  assert.equal(result.report.totals.extracted, 1);
  assert.equal(result.report.totals.audited, 1);
  assert.equal(result.jevUnavailable, false);
});

test("runAudit: a sensitive (denylisted) function is never sent to evaluateFn", async () => {
  const files = { "src/secretStuff.ts": CHANGED_SRC };
  let called = 0;
  const evaluateFn = async () => {
    called++;
    return null;
  };
  const result = await runAudit({
    cwd: "/repo",
    config: CONFIG,
    mode: "changed",
    baseBranch: "main",
    readFileFn: fakeFiles(files),
    discoverChangedFilesFn: async () => ["src/secretStuff.ts"],
    discoverAllFilesFn: async () => ["src/secretStuff.ts"],
    discoverTestFilesFn: async () => [],
    evaluateFn,
    noDup: true,
  });
  assert.equal(called, 0);
  assert.deepEqual(result.report.notAudited, ["src/secretStuff.ts#riskyEval"]);
});

test("runAudit: Jev unavailable (every evaluateFn call fails-open to null) is reported and rules that need it never block", async () => {
  const files = { "src/a.ts": CHANGED_SRC };
  const evaluateFn = async () => null; // simulates safeEvaluate's fail-open behavior
  const result = await runAudit({
    cwd: "/repo",
    config: CONFIG,
    mode: "changed",
    baseBranch: "main",
    readFileFn: fakeFiles(files),
    discoverChangedFilesFn: async () => ["src/a.ts"],
    discoverAllFilesFn: async () => ["src/a.ts"],
    discoverTestFilesFn: async () => [],
    evaluateFn,
    noDup: true,
  });
  assert.equal(result.jevUnavailable, true);
  const gate = evaluateGate(result.report, DEFAULT_THRESHOLDS, { jevUnavailable: result.jevUnavailable });
  assert.equal(gate.ok, true); // no deterministic (exact-dup) finding here, and Jev-dependent rules are skipped
});

test("runAudit: an exact duplicate of an existing function is caught even when only one side changed", async () => {
  // Same normalized body (comments/whitespace aside) copy-pasted into two files — the
  // "jsonResponse pasted into 16 route files" shape rule 1 exists to catch deterministically.
  const body = "export function jsonResponse(x) {\n  const y = x + 1;\n  const z = y * 2;\n  return z - 1;\n}\n";
  const files = {
    "src/a.ts": body,
    "src/b.ts": `// a different file, identical function\n${body}`,
  };
  const evaluateFn = async () => null;
  const result = await runAudit({
    cwd: "/repo",
    config: CONFIG,
    mode: "changed",
    baseBranch: "main",
    readFileFn: fakeFiles(files),
    discoverChangedFilesFn: async () => ["src/a.ts"], // only a.ts is "changed"
    discoverAllFilesFn: async () => ["src/a.ts", "src/b.ts"], // b.ts still exists in the universe
    discoverTestFilesFn: async () => [],
    evaluateFn,
  });
  assert.equal(result.report.exactDuplicateClusters.length, 1);
  const gate = evaluateGate(result.report, DEFAULT_THRESHOLDS, { jevUnavailable: result.jevUnavailable });
  assert.equal(gate.ok, false);
  assert.equal(gate.blockingFindings[0].rule, "exact-duplicate");
});

test("resolveBaseBranch falls back to maple.config.json repo.devBranch, then main", async () => {
  const readFileFn = async () => JSON.stringify({ repo: { devBranch: "development" } });
  assert.equal(await resolveBaseBranch(undefined, "/repo", readFileFn), "development");
  assert.equal(await resolveBaseBranch("release", "/repo", readFileFn), "release");
  const noConfig = async () => {
    throw new Error("ENOENT");
  };
  assert.equal(await resolveBaseBranch(undefined, "/repo", noConfig), "main");
});
