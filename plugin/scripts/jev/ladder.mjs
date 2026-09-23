#!/usr/bin/env node
/**
 * ladder.mjs — the executor ladder jev-model-routing climbs.
 *
 * Owner decision (logged as a decision via the allocator, see
 * plugin/README.md's Jev section): the DEFAULT executor is the cheapest
 * one — Pi on gpt-5.6-luna — whenever Pi is available and its ChatGPT quota
 * is open. The burden is inverted from the original v0.3.0 design: route
 * to pi+luna unless Jev is CONFIDENT (>= ESCALATION_CONFIDENCE_FLOOR) the
 * task needs more.
 *
 * Ladder (both the routing rungs AND the escalation-after-a-failed-
 * validation order — same sequence, walked one step at a time by
 * nextRung()):
 *   gpt-5.6-luna -> gpt-5.6-terra -> gpt-5.6-sol -> sonnet -> opus
 *
 * Jev picks the STARTING rung, not necessarily luna:
 *   small                                  -> pi/gpt-5.6-luna (the default)
 *   medium                                 -> pi/gpt-5.6-terra
 *   big / high-risk / production / security -> sonnet or opus (Jev's own call between the two)
 *
 * route.mjs asks one CHOICE question whose four labels map 1:1 to a
 * starting rung via startModelFor() — RUNG_CHOICES is that question's
 * `criteria` object (label -> description Jev is judged against).
 *
 * Naming note: MapleLens's tools/jev/worker-pi.mjs also exports a
 * `PI_MODEL_LADDER` (3 entries, Pi-only: luna/terra/sol — the models one
 * Pi worker escalates across) and a `startModelFor({model, size})` (2-way
 * small-vs-medium/big pick within Pi). This module's exports share those
 * names because the owner's instruction pointed at that file as the
 * reference, but they are NOT the same functions: this ladder spans
 * PROVIDERS (Pi's three models, then sonnet, then opus) because
 * jev-model-routing decides the provider too, not just which Pi model —
 * something worker-pi.mjs, already inside a Pi session, never needs to
 * decide. Do not port these two modules 1:1 against each other.
 */

export const PI_MODEL_LADDER = ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "sonnet", "opus"];

/** The rung used whenever Jev doesn't confidently say otherwise, or is unavailable and Pi is up. */
export const DEFAULT_PI_MODEL = "gpt-5.6-luna";

/** Jev unavailable AND Pi unavailable -> here. Never opus on a fail-open path — that's an escalation only Jev or a real validation failure should trigger. */
export const DEFAULT_FALLBACK_MODEL = "sonnet";

/** Below this confidence, a Jev answer that would escalate PAST the default rung is not trusted — stay on default instead. */
export const ESCALATION_CONFIDENCE_FLOOR = 0.8;

/** jev-model-routing's CHOICE question labels -> the ladder rung each one starts at. */
const RUNG_BY_CHOICE = {
  "pi-luna": "gpt-5.6-luna",
  "pi-terra": "gpt-5.6-terra",
  sonnet: "sonnet",
  opus: "opus",
};

/** `criteria` for the routing CHOICE question — label -> description Jev is judged against. */
export const RUNG_CHOICES = {
  "pi-luna": "Small, routine work — the default. Mechanical edits, narrow lookups, simple search, straightforward well-scoped implementation.",
  "pi-terra": "Medium work — more moving parts than pi-luna handles well, but not architecturally hard or high-stakes.",
  sonnet: "Big work, or touches something risky (production, a data migration, security) without being the HARDEST case — ordinary careful engineering judgment needed.",
  opus: "The hardest or highest-stakes case: genuinely hard reasoning/architecture, or risk to production/security/data that demands the most capable model.",
};

/** @param {string} choice one of RUNG_CHOICES's keys @returns {string} a PI_MODEL_LADDER entry */
export function startModelFor(choice) {
  return RUNG_BY_CHOICE[choice] ?? DEFAULT_PI_MODEL;
}

/** @param {string} model @returns {boolean} true for a Pi-hosted rung (gpt-5.6-*), false for sonnet/opus. */
export function isPiModel(model) {
  return typeof model === "string" && model.startsWith("gpt-5.6-");
}

/**
 * The next rung up the ladder after `model` — the escalation-after-a-
 * failed-validation step (goal: "Escalation after a failed validation:
 * gpt-5.6-luna -> gpt-5.6-terra -> gpt-5.6-sol -> sonnet -> opus").
 * `opus` is the ceiling: escalating past it returns `opus` unchanged (there
 * is nowhere higher to go — a caller at the ceiling needs a human, not
 * another automatic escalation).
 * @param {string} model @returns {string}
 */
export function nextRung(model) {
  const i = PI_MODEL_LADDER.indexOf(model);
  if (i === -1) return DEFAULT_PI_MODEL; // unknown input — restart from the bottom rather than guess
  return PI_MODEL_LADDER[Math.min(i + 1, PI_MODEL_LADDER.length - 1)];
}
