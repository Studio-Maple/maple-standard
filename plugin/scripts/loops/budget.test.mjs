#!/usr/bin/env node
/**
 * budget.test.mjs — standalone test for budget.mjs (see state.test.mjs
 * header for the repo's standalone test-style convention).
 *   node plugin/scripts/loops/budget.test.mjs
 */
import { checkBudget } from "./budget.mjs";

const results = [];
function pass(name, detail) {
  results.push({ name, passed: true });
  console.log(`  PASS  ${name} — ${detail}`);
}
function fail(name, detail) {
  results.push({ name, passed: false });
  console.log(`  FAIL  ${name} — ${detail}`);
}

function testUnderCountLimitNotExceeded() {
  const r = checkBudget({ usedCount: 39, countLimit: 40 });
  if (r.exceeded === false) pass("under count limit -> not exceeded", `39/40 -> exceeded=${r.exceeded}`);
  else fail("under count limit -> not exceeded", JSON.stringify(r));
}

function testAtCountLimitIsExceeded() {
  const r = checkBudget({ usedCount: 40, countLimit: 40 });
  if (r.exceeded === true && r.reasons.some((x) => x.startsWith("count:"))) {
    pass("AT count limit -> exceeded (boundary)", `40/40 -> exceeded=${r.exceeded}, reasons=${JSON.stringify(r.reasons)}`);
  } else {
    fail("AT count limit -> exceeded (boundary)", JSON.stringify(r));
  }
}

function testOverCountLimitIsExceeded() {
  const r = checkBudget({ usedCount: 41, countLimit: 40 });
  if (r.exceeded === true) pass("over count limit -> exceeded", `41/40 -> exceeded=${r.exceeded}`);
  else fail("over count limit -> exceeded", JSON.stringify(r));
}

function testMinutesUnderLimitNotExceeded() {
  const startedAt = "2026-07-25T00:00:00.000Z";
  const now = Date.parse(startedAt) + 19 * 60000; // 19 minutes elapsed
  const r = checkBudget({ startedAt, minutesLimit: 20, now });
  if (r.exceeded === false && Math.round(r.elapsedMinutes) === 19) {
    pass("under minutes limit -> not exceeded", `elapsed=${r.elapsedMinutes}m, exceeded=${r.exceeded}`);
  } else {
    fail("under minutes limit -> not exceeded", JSON.stringify(r));
  }
}

function testMinutesAtLimitIsExceeded() {
  const startedAt = "2026-07-25T00:00:00.000Z";
  const now = Date.parse(startedAt) + 20 * 60000; // exactly 20 minutes elapsed
  const r = checkBudget({ startedAt, minutesLimit: 20, now });
  if (r.exceeded === true && r.reasons.some((x) => x.startsWith("elapsed:"))) {
    pass("AT minutes limit -> exceeded (boundary)", `elapsed=${r.elapsedMinutes}m, reasons=${JSON.stringify(r.reasons)}`);
  } else {
    fail("AT minutes limit -> exceeded (boundary)", JSON.stringify(r));
  }
}

function testNoLimitsConfiguredNeverExceeds() {
  const r = checkBudget({ usedCount: 999999 });
  if (r.exceeded === false && r.reasons.length === 0) {
    pass("no limits configured -> never exceeded", `usedCount=999999, exceeded=${r.exceeded}`);
  } else {
    fail("no limits configured -> never exceeded", JSON.stringify(r));
  }
}

function testBothDimensionsCanTriggerIndependently() {
  // count exceeded, minutes fine
  const r1 = checkBudget({ usedCount: 40, countLimit: 40, startedAt: Date.now(), minutesLimit: 20, now: Date.now() });
  // minutes exceeded, count fine
  const startedAt = "2026-07-25T00:00:00.000Z";
  const now = Date.parse(startedAt) + 25 * 60000;
  const r2 = checkBudget({ usedCount: 1, countLimit: 40, startedAt, minutesLimit: 20, now });
  if (r1.exceeded && r2.exceeded) {
    pass("either dimension alone triggers exceeded", `count-only=${JSON.stringify(r1.reasons)}, minutes-only=${JSON.stringify(r2.reasons)}`);
  } else {
    fail("either dimension alone triggers exceeded", `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);
  }
}

function testSessionCapUsesSameCheck() {
  // session-level cap: cyclesUsed/cyclesLimit and hoursLimit expressed as minutesLimit = hours*60
  const startedAt = "2026-07-25T20:00:00.000Z";
  const hoursLimit = 8;
  const now = Date.parse(startedAt) + hoursLimit * 60 * 60000; // exactly 8 hours later
  const r = checkBudget({ usedCount: 5, countLimit: 999, startedAt, minutesLimit: hoursLimit * 60, now });
  if (r.exceeded === true) {
    pass("session-level hours cap (same core check)", `elapsed=${r.elapsedMinutes}m at an 8h cap -> exceeded=${r.exceeded}`);
  } else {
    fail("session-level hours cap (same core check)", JSON.stringify(r));
  }
}

function main() {
  testUnderCountLimitNotExceeded();
  testAtCountLimitIsExceeded();
  testOverCountLimitIsExceeded();
  testMinutesUnderLimitNotExceeded();
  testMinutesAtLimitIsExceeded();
  testNoLimitsConfiguredNeverExceeds();
  testBothDimensionsCanTriggerIndependently();
  testSessionCapUsesSameCheck();

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} assertions passed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
