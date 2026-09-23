#!/usr/bin/env node
/**
 * skill-select.mjs — jev-skill-select skill's decision logic.
 *
 * Concept ported from hermes-jev-skills' jevkit/skillpick.py (MIT — see
 * plugin/skills/jev-skill-select/NOTICE): rank the installed skill catalog
 * against the request and let Jev say "none apply" rather than the session
 * guessing from descriptions alone. This Node version is a single-request
 * simplification (jevkit's batches-of-120 + two-round-trip design targets
 * catalogs of hundreds of skills across a whole Hermes fleet; a single
 * Claude Code session's catalog is small enough — Anthropic's own
 * documented practical ceiling is dozens, not hundreds — that one CHOICE
 * request covers it. See plugin/README.md's Jev section "Gap" note.)
 */
import { safeEvaluate, decide } from "./client.mjs";
import { resolveJevConfig } from "./config.mjs";
import { logDecision } from "./log.mjs";
import { clip, redact, looksSensitive } from "./redact.mjs";

const MAX_SKILLS = 40; // keep the payload small and the single CHOICE question tractable

/**
 * @param {object} args
 * @param {string} args.root project root
 * @param {string} args.request the user's request / current task text
 * @param {{name:string, description:string}[]} args.skills installed skill catalog (name + first-line description)
 * @param {{safeEvaluate?: typeof safeEvaluate}} [deps] test seam
 * @returns {Promise<{skill:string|null, confidence:number|null, source:'jev'|'fallback', reason?:string}>}
 */
export async function pickSkill({ root, request, skills }, deps = {}) {
  const evalFn = deps.safeEvaluate ?? safeEvaluate;
  const cfg = resolveJevConfig(root);
  const none = { skill: null, confidence: null, source: "fallback" };

  if (!cfg.enabled) return { ...none, reason: "jev disabled" };
  if (!Array.isArray(skills) || skills.length === 0) return { ...none, reason: "no skills to rank" };

  const requestText = String(request ?? "");
  if (looksSensitive(requestText)) return { ...none, reason: "request text looked sensitive — not sent to Jev" };

  const catalog = skills.slice(0, MAX_SKILLS).map((s) => ({
    name: s.name,
    description: clip(redact(String(s.description ?? "")), 200),
  }));
  const names = catalog.map((s) => s.name);

  const question = {
    skill: {
      type: "choice",
      instructions:
        "Given the request and the catalog of available skills (name + one-line " +
        "description) below, which skill (if any) should be loaded to help with " +
        "this request? Only choose a skill whose description clearly covers what " +
        "the request needs — do not choose one that is merely thematically " +
        "related. Choose 'none' if no skill clearly applies.",
      // Jev's "choice" type wants criteria as {label: description}, not a
      // bare array — each skill's own (already clipped+redacted)
      // description IS its criterion text here.
      criteria: { ...Object.fromEntries(catalog.map((s) => [s.name, s.description || s.name])), none: "No skill in the catalog clearly applies." },
    },
  };

  const state = { request: clip(redact(requestText), 600), catalog };
  const result = await evalFn(root, state, question, { timeoutMs: cfg.timeoutMs });

  let outcome;
  if (!result) {
    outcome = { ...none, reason: "jev unavailable — fail-open" };
  } else {
    const choice = decide(result.answers?.skill, cfg.confidenceFloor);
    if (!choice || choice === "none" || !names.includes(choice)) {
      outcome = { ...none, confidence: result.answers?.skill?.confidence ?? null, source: "jev", reason: "jev found no clear match" };
    } else {
      outcome = { skill: choice, confidence: result.answers.skill.confidence, source: "jev" };
    }
  }

  logDecision(root, { kind: "skill-select", ...outcome, requestPreview: clip(redact(requestText), 150), catalogSize: skills.length });
  return outcome;
}
