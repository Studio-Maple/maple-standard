#!/usr/bin/env node
/**
 * pick-loop.test.mjs — standalone test for pick-loop.mjs (see
 * state.test.mjs header for the repo's standalone test-style convention).
 *   node plugin/scripts/loops/pick-loop.test.mjs
 *
 * Every scenario below hand-computes the expected pick sequence from the
 * algorithm's own rules (documented in pick-loop.mjs's header) so a
 * regression in the tie-break/cooldown/priority logic actually fails a
 * concrete assertion, not a vague "looks plausible" check.
 */
import { pickLoop } from "./pick-loop.mjs";

const results = [];
function pass(name, detail) {
  results.push({ name, passed: true });
  console.log(`  PASS  ${name} — ${detail}`);
}
function fail(name, detail) {
  results.push({ name, passed: false });
  console.log(`  FAIL  ${name} — ${detail}`);
}

const ENABLED = ["sweep-errors", "burn-backlog", "sweep-quality", "detect-drift"];

function testDeterminismSameInputSameOutput() {
  const config = { loops: { enabled: ENABLED } };
  const ledgerEntries = [{ loop: "sweep-errors", outcome: "fixed", ts: "t1" }];
  const r1 = pickLoop({ config, ledgerEntries });
  const r2 = pickLoop({ config, ledgerEntries: [...ledgerEntries] });
  if (JSON.stringify(r1) === JSON.stringify(r2)) {
    pass("determinism: same ledger -> same pick", `both calls picked "${r1.loop}"`);
  } else {
    fail("determinism: same ledger -> same pick", `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);
  }
}

function testRoundRobinAdvancesEqualWeights() {
  const config = { loops: { enabled: ENABLED } };
  const ledgerEntries = [];
  const picks = [];
  for (let i = 0; i < 5; i++) {
    const { loop } = pickLoop({ config, ledgerEntries });
    picks.push(loop);
    ledgerEntries.push({ loop, outcome: "ran", ts: `t${i}` });
  }
  const expected = ["sweep-errors", "burn-backlog", "sweep-quality", "detect-drift", "sweep-errors"];
  if (JSON.stringify(picks) === JSON.stringify(expected)) {
    pass("round-robin advances (equal weights)", `sequence: ${picks.join(" -> ")}`);
  } else {
    fail("round-robin advances (equal weights)", `expected ${expected.join(",")}, got ${picks.join(",")}`);
  }
}

function testWeightedRoundRobinFavorsHeavierLoop() {
  const config = { loops: { enabled: ENABLED, weights: { "sweep-errors": 2 } } };
  const ledgerEntries = [];
  const picks = [];
  for (let i = 0; i < 8; i++) {
    const { loop } = pickLoop({ config, ledgerEntries });
    picks.push(loop);
    ledgerEntries.push({ loop, outcome: "ran", ts: `t${i}` });
  }
  const expected = [
    "sweep-errors",
    "burn-backlog",
    "sweep-quality",
    "detect-drift",
    "sweep-errors",
    "sweep-errors",
    "burn-backlog",
    "sweep-quality",
  ];
  const seCount = picks.filter((p) => p === "sweep-errors").length;
  const ddCount = picks.filter((p) => p === "detect-drift").length;
  if (JSON.stringify(picks) === JSON.stringify(expected) && seCount > ddCount) {
    pass("weighted round-robin favors weight-2 loop", `sequence: ${picks.join(" -> ")} (sweep-errors x${seCount} vs detect-drift x${ddCount})`);
  } else {
    fail("weighted round-robin favors weight-2 loop", `expected ${expected.join(",")}, got ${picks.join(",")}`);
  }
}

function testCooldownHonored() {
  const config = { loops: { enabled: ENABLED, cooldownCycles: 2 } };
  const ledgerEntries = [
    { loop: "sweep-errors", outcome: "fixed", ts: "t1" },
    { loop: "burn-backlog", outcome: "fixed", ts: "t2" },
    { loop: "sweep-quality", outcome: "fixed", ts: "t3" },
    { loop: "detect-drift", outcome: "quiet", ts: "t4" }, // most recent, quiet, cyclesAgo=0 < cooldown(2)
  ];
  const result = pickLoop({ config, ledgerEntries });
  const excludedDriftCorrectly = !result.candidates.includes("detect-drift");
  if (result.loop === "sweep-errors" && excludedDriftCorrectly) {
    pass("cooldown honored", `picked "${result.loop}", candidates=${JSON.stringify(result.candidates)} (detect-drift excluded)`);
  } else {
    fail("cooldown honored", `got ${JSON.stringify(result)}`);
  }
}

function testPriorityOverride() {
  const config = { loops: { enabled: ENABLED } }; // default cooldownCycles=3
  const ledgerEntries = [
    { loop: "sweep-errors", outcome: "fixed", ts: "t1" },
    { loop: "sweep-errors", outcome: "fixed", ts: "t2" },
    { loop: "sweep-errors", outcome: "quiet", ts: "t3" }, // most recent overall, quiet, cyclesAgo=0 < 3 -> would cool down
  ];

  const withoutPriority = pickLoop({ config, ledgerEntries, sweepErrorsPriority: false });
  const withPriority = pickLoop({ config, ledgerEntries, sweepErrorsPriority: true });

  const cooldownAppliedNormally = withoutPriority.loop !== "sweep-errors";
  const priorityForcedIt = withPriority.loop === "sweep-errors" && /priority override/.test(withPriority.reason);

  if (cooldownAppliedNormally && priorityForcedIt) {
    pass(
      "priority override forces sweep-errors",
      `without priority -> "${withoutPriority.loop}" (cooldown applied); with priority -> "${withPriority.loop}"`
    );
  } else {
    fail("priority override forces sweep-errors", `withoutPriority=${JSON.stringify(withoutPriority)} withPriority=${JSON.stringify(withPriority)}`);
  }
}

function testAllLoopsCoolingDownFallsBack() {
  const config = { loops: { enabled: ENABLED, cooldownCycles: 4 } };
  const ledgerEntries = [
    { loop: "sweep-errors", outcome: "quiet", ts: "t1" },
    { loop: "burn-backlog", outcome: "quiet", ts: "t2" },
    { loop: "sweep-quality", outcome: "quiet", ts: "t3" },
    { loop: "detect-drift", outcome: "quiet", ts: "t4" },
  ];
  const result = pickLoop({ config, ledgerEntries });
  const fallbackUsed = result.candidates.length === ENABLED.length && /ignoring cooldown/.test(result.reason);
  if (ENABLED.includes(result.loop) && fallbackUsed) {
    pass("all-cooling-down falls back to full set", `picked "${result.loop}", reason="${result.reason}"`);
  } else {
    fail("all-cooling-down falls back to full set", `got ${JSON.stringify(result)}`);
  }
}

function testEmptyEnabledThrows() {
  let threw = false;
  try {
    pickLoop({ config: { loops: { enabled: [] } }, ledgerEntries: [] });
  } catch {
    threw = true;
  }
  if (threw) {
    pass("empty loops.enabled throws", "refuses to pick from nothing rather than guessing");
  } else {
    fail("empty loops.enabled throws", "expected a thrown error");
  }
}

function main() {
  testDeterminismSameInputSameOutput();
  testRoundRobinAdvancesEqualWeights();
  testWeightedRoundRobinFavorsHeavierLoop();
  testCooldownHonored();
  testPriorityOverride();
  testAllLoopsCoolingDownFallsBack();
  testEmptyEnabledThrows();

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} assertions passed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
