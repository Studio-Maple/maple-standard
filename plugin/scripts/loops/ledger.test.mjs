#!/usr/bin/env node
/**
 * ledger.test.mjs — standalone test for ledger.mjs (see state.test.mjs
 * header for the repo's standalone test-style convention).
 *   node plugin/scripts/loops/ledger.test.mjs
 */
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedgerEntry, readLedgerEntries, summarizeLedger, ledgerFilePath, validateLedgerEntry } from "./ledger.mjs";
import { loopStateDir } from "./state.mjs";

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
  const root = mkdtempSync(join(tmpdir(), "loop-ledger-test-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function testAppendAndReadRoundTrip() {
  withTmpRoot((root) => {
    const entries = [
      { ts: "2026-07-25T01:00:00Z", loop: "sweep-errors", outcome: "fixed", commit: "abc1234", budgetUsed: { turns: 5, minutes: 4 } },
      { ts: "2026-07-25T01:20:00Z", loop: "burn-backlog", outcome: "quiet", commit: null, budgetUsed: { turns: 1, minutes: 1 } },
      { ts: "2026-07-25T01:40:00Z", loop: "sweep-quality", outcome: "fixed", commit: "def5678", budgetUsed: { turns: 8, minutes: 12 } },
    ];
    for (const e of entries) appendLedgerEntry(root, e);
    const { entries: readBack, warnings } = readLedgerEntries(root);
    if (warnings.length === 0 && JSON.stringify(readBack) === JSON.stringify(entries)) {
      pass("append + read round trip", `${readBack.length} entries, order preserved`);
    } else {
      fail("append + read round trip", `got ${JSON.stringify({ readBack, warnings })}`);
    }
  });
}

function testSummarizeRoundTrip() {
  withTmpRoot((root) => {
    appendLedgerEntry(root, { ts: "t1", loop: "sweep-errors", outcome: "fixed", commit: "sha1", budgetUsed: {} });
    appendLedgerEntry(root, { ts: "t2", loop: "sweep-errors", outcome: "quiet", commit: null, budgetUsed: {} });
    appendLedgerEntry(root, { ts: "t3", loop: "burn-backlog", outcome: "fixed", commit: "sha2", budgetUsed: {} });
    appendLedgerEntry(root, { ts: "t4", loop: "burn-backlog", outcome: "gate-red", commit: null, budgetUsed: {} });

    const summary = summarizeLedger(root);
    const okCounts =
      summary.totalCycles === 4 &&
      summary.perLoop["sweep-errors"].count === 2 &&
      summary.perLoop["sweep-errors"].outcomes.fixed === 1 &&
      summary.perLoop["sweep-errors"].outcomes.quiet === 1 &&
      summary.perLoop["burn-backlog"].count === 2 &&
      summary.commits.length === 2 &&
      summary.firstTs === "t1" &&
      summary.lastTs === "t4";
    if (okCounts) {
      pass("summarize counts + commit list", `totalCycles=${summary.totalCycles}, commits=${summary.commits.length}`);
    } else {
      fail("summarize counts + commit list", `got ${JSON.stringify(summary)}`);
    }
  });
}

function testCorruptLineTolerance() {
  withTmpRoot((root) => {
    mkdirSync(loopStateDir(root), { recursive: true });
    const file = ledgerFilePath(root);
    appendFileSync(file, JSON.stringify({ ts: "t1", loop: "detect-drift", outcome: "fixed", commit: "sha9", budgetUsed: {} }) + "\n");
    appendFileSync(file, "{ this is not json\n");
    appendFileSync(file, JSON.stringify({ ts: "t2", loop: "detect-drift", outcome: "quiet", commit: null }) + "\n"); // missing budgetUsed
    appendFileSync(file, JSON.stringify({ ts: "t3", loop: "detect-drift", outcome: "quiet", commit: null, budgetUsed: {} }) + "\n");

    const { entries, warnings } = readLedgerEntries(root);
    if (entries.length === 2 && warnings.length === 2) {
      pass("corrupt/invalid line tolerance", `2 valid entries kept, 2 warnings: ${warnings.join(" | ")}`);
    } else {
      fail("corrupt/invalid line tolerance", `got entries=${entries.length}, warnings=${JSON.stringify(warnings)}`);
    }
  });
}

function testInvalidEntryRejectedOnAppend() {
  withTmpRoot((root) => {
    let threw = false;
    try {
      appendLedgerEntry(root, { ts: "t1", loop: "sweep-errors" }); // missing outcome/commit/budgetUsed
    } catch {
      threw = true;
    }
    const problems = validateLedgerEntry({ ts: "t1", loop: "sweep-errors" });
    if (threw && problems.length === 3) {
      pass("invalid entry rejected on append", `validateLedgerEntry found ${problems.length} problems, append threw`);
    } else {
      fail("invalid entry rejected on append", `threw=${threw}, problems=${JSON.stringify(problems)}`);
    }
  });
}

function testEmptyLedgerSummary() {
  withTmpRoot((root) => {
    const summary = summarizeLedger(root);
    if (summary.totalCycles === 0 && summary.commits.length === 0 && summary.firstTs === null) {
      pass("empty ledger summarizes cleanly", "no file yet -> zeroed summary, no throw");
    } else {
      fail("empty ledger summarizes cleanly", `got ${JSON.stringify(summary)}`);
    }
  });
}

function main() {
  testAppendAndReadRoundTrip();
  testSummarizeRoundTrip();
  testCorruptLineTolerance();
  testInvalidEntryRejectedOnAppend();
  testEmptyLedgerSummary();

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} assertions passed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
