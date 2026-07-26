#!/usr/bin/env node
/**
 * state.test.mjs — standalone test for state.mjs (repo's standalone test
 * style, see supabase/tests/rls-baseline.test.mjs: plain Node script, no
 * framework, exits non-zero on any failed assertion). Run directly:
 *   node plugin/scripts/loops/state.test.mjs
 * or via plugin/scripts/loops/run-tests.mjs (all *.test.mjs in this dir).
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLoopState, writeLoopState, loopStateFilePath, loopStateDir, listStateDir } from "./state.mjs";

const results = [];
function pass(name, detail) {
  results.push({ name, passed: true });
  console.log(`  PASS  ${name} — ${detail}`);
}
function fail(name, detail) {
  results.push({ name, passed: false });
  console.log(`  FAIL  ${name} — ${detail}`);
}

function withTmpRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "loop-state-test-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testMissingStateStartsFresh() {
  withTmpRoot((root) => {
    const { state, recovered, warning } = readLoopState(root, "sweep-errors", { defaultState: { cursor: null } });
    if (recovered === false && warning === null && JSON.stringify(state) === JSON.stringify({ cursor: null })) {
      pass("missing state starts fresh", "no file on disk -> default, no warning");
    } else {
      fail("missing state starts fresh", `got ${JSON.stringify({ state, recovered, warning })}`);
    }
  });
}

function testWriteReadRoundTrip() {
  withTmpRoot((root) => {
    const written = { fingerprints: { abc123: "fixed" }, updatedAt: "2026-07-25T00:00:00Z" };
    writeLoopState(root, "sweep-errors", written);
    const { state, recovered, warning } = readLoopState(root, "sweep-errors");
    if (!recovered && !warning && JSON.stringify(state) === JSON.stringify(written)) {
      pass("write/read round trip", "state matches exactly");
    } else {
      fail("write/read round trip", `got ${JSON.stringify({ state, recovered, warning })}`);
    }
  });
}

function testCorruptStateRecovery() {
  withTmpRoot((root) => {
    mkdirSync(loopStateDir(root), { recursive: true });
    writeFileSync(loopStateFilePath(root, "burn-backlog"), "{ not valid json at all", "utf8");
    const { state, recovered, warning } = readLoopState(root, "burn-backlog", { defaultState: { claims: {} } });
    if (recovered === true && typeof warning === "string" && JSON.stringify(state) === JSON.stringify({ claims: {} })) {
      pass("corrupt state recovery", "fell back to default with a warning, did not throw");
    } else {
      fail("corrupt state recovery", `got ${JSON.stringify({ state, recovered, warning })}`);
    }
  });
}

function testNonObjectJsonTreatedAsCorrupt() {
  withTmpRoot((root) => {
    mkdirSync(loopStateDir(root), { recursive: true });
    writeFileSync(loopStateFilePath(root, "sweep-quality"), "[1,2,3]", "utf8");
    const { recovered, warning } = readLoopState(root, "sweep-quality", { defaultState: { reviewedCommits: [] } });
    if (recovered === true && warning) {
      pass("non-object JSON root rejected", "array-rooted file treated as corrupt, fell back");
    } else {
      fail("non-object JSON root rejected", `expected recovery, got recovered=${recovered}`);
    }
  });
}

function testAtomicWriteLeavesNoTmpFile() {
  withTmpRoot((root) => {
    writeLoopState(root, "detect-drift", { cursor: "docs/index.md" });
    const dirEntries = listStateDir(root);
    const leftoverTmp = dirEntries.some((f) => f.includes(".tmp"));
    if (!leftoverTmp && dirEntries.includes("detect-drift.json")) {
      pass("atomic write leaves no tmp file", `dir: ${dirEntries.join(", ")}`);
    } else {
      fail("atomic write leaves no tmp file", `dir: ${dirEntries.join(", ")}`);
    }
  });
}

function testWriteOverwritesExisting() {
  withTmpRoot((root) => {
    writeLoopState(root, "sweep-errors", { attempt: 1 });
    writeLoopState(root, "sweep-errors", { attempt: 2 });
    const { state } = readLoopState(root, "sweep-errors");
    if (state.attempt === 2) {
      pass("write overwrites existing state", "second write superseded the first");
    } else {
      fail("write overwrites existing state", `got ${JSON.stringify(state)}`);
    }
  });
}

function main() {
  testMissingStateStartsFresh();
  testWriteReadRoundTrip();
  testCorruptStateRecovery();
  testNonObjectJsonTreatedAsCorrupt();
  testAtomicWriteLeavesNoTmpFile();
  testWriteOverwritesExisting();

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} assertions passed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
