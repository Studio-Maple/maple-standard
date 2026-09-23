#!/usr/bin/env node
import {
  PI_MODEL_LADDER,
  DEFAULT_PI_MODEL,
  DEFAULT_FALLBACK_MODEL,
  ESCALATION_CONFIDENCE_FLOOR,
  RUNG_CHOICES,
  startModelFor,
  isPiModel,
  nextRung,
} from "./ladder.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const eq = (name, actual, expected) => check(name, actual === expected, actual === expected ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

eq("ladder order", JSON.stringify(PI_MODEL_LADDER), JSON.stringify(["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "sonnet", "opus"]));
eq("default rung is luna", DEFAULT_PI_MODEL, "gpt-5.6-luna");
eq("fail-open-with-no-pi fallback is sonnet, never opus", DEFAULT_FALLBACK_MODEL, "sonnet");
eq("escalation confidence floor is 0.8", ESCALATION_CONFIDENCE_FLOOR, 0.8);
check("RUNG_CHOICES has exactly the four routing labels", JSON.stringify(Object.keys(RUNG_CHOICES).sort()) === JSON.stringify(["opus", "pi-luna", "pi-terra", "sonnet"]));

eq("pi-luna starts at gpt-5.6-luna", startModelFor("pi-luna"), "gpt-5.6-luna");
eq("pi-terra starts at gpt-5.6-terra", startModelFor("pi-terra"), "gpt-5.6-terra");
eq("sonnet choice starts at sonnet", startModelFor("sonnet"), "sonnet");
eq("opus choice starts at opus", startModelFor("opus"), "opus");
eq("an unrecognized choice defaults to luna", startModelFor("bogus"), "gpt-5.6-luna");
eq("no choice at all defaults to luna", startModelFor(undefined), "gpt-5.6-luna");

check("isPiModel true for all three Pi rungs", ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"].every(isPiModel));
check("isPiModel false for sonnet/opus", !isPiModel("sonnet") && !isPiModel("opus"));
check("isPiModel false for junk", !isPiModel("gpt-4") && !isPiModel(undefined));

eq("luna escalates to terra", nextRung("gpt-5.6-luna"), "gpt-5.6-terra");
eq("terra escalates to sol", nextRung("gpt-5.6-terra"), "gpt-5.6-sol");
eq("sol escalates to sonnet", nextRung("gpt-5.6-sol"), "sonnet");
eq("sonnet escalates to opus", nextRung("sonnet"), "opus");
eq("opus is the ceiling — escalating stays at opus", nextRung("opus"), "opus");
eq("an unknown model restarts at the bottom rather than guessing", nextRung("gpt-4-turbo"), "gpt-5.6-luna");

// Full escalation walk from the bottom reaches the ceiling and stays there.
{
  let m = DEFAULT_PI_MODEL;
  const walk = [m];
  for (let i = 0; i < 6; i++) {
    m = nextRung(m);
    walk.push(m);
  }
  eq("six escalations from luna land on, and stay at, opus", walk.join(">"), "gpt-5.6-luna>gpt-5.6-terra>gpt-5.6-sol>sonnet>opus>opus>opus");
}

if (failed > 0) {
  console.error(`${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("All ladder.mjs checks passed.");
