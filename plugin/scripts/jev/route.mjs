#!/usr/bin/env node
/**
 * route.mjs — jev-model-routing skill's decision logic.
 *
 * Ports the ROUTING CONCEPT from hermes-jev-skills' jevkit/route.py (MIT —
 * see plugin/skills/jev-model-routing/NOTICE): ask Jev one CHOICE question
 * about how much executor a piece of work needs, act on the label only
 * when Jev is confident, and fail open to a safe default otherwise. This
 * is a from-scratch Node implementation for maple-standard's own executor
 * set (haiku/sonnet/opus/pi), not a line-for-line port of the multi-vendor
 * OpenRouter pool machinery in jevkit/route.py — that pool/tier config
 * model doesn't apply here (this plugin has exactly four executors, no
 * per-project pools file).
 */
import { safeEvaluate, decide } from "./client.mjs";
import { resolveJevConfig } from "./config.mjs";
import { logDecision } from "./log.mjs";
import { clip, redact, looksSensitive } from "./redact.mjs";
import { piAvailable } from "./pi-run.mjs";

export const EXECUTORS = ["haiku", "sonnet", "opus", "pi"];
export const DEFAULT_EXECUTOR = "sonnet";

const QUESTION = {
  executor: {
    type: "choice",
    instructions:
      "A coding agent is about to delegate a task to a sub-agent. Choose the " +
      "CHEAPEST executor that is still capable of doing the task well. " +
      "'haiku' = trivial, mechanical, narrow (rename, format, single lookup, " +
      "simple search). 'sonnet' = ordinary implementation/debugging work, the " +
      "safe default. 'opus' = genuinely hard reasoning, architecture, or high-" +
      "stakes correctness (security, data migration, production). 'pi' = a " +
      "well-scoped, self-contained coding task that fits a headless worktree " +
      "run with no back-and-forth needed.",
    criteria: {
      haiku: "Trivial, mechanical, narrow work: rename, format, single lookup, simple search.",
      sonnet: "Ordinary implementation/debugging work — the safe default when unsure.",
      opus: "Genuinely hard reasoning, architecture, or high-stakes correctness (security, data migration, production).",
      pi: "A well-scoped, self-contained coding task that fits a headless worktree run with no back-and-forth needed.",
    },
  },
};

/**
 * @param {object} args
 * @param {string} args.root project root
 * @param {string} args.task the task/prompt about to be delegated
 * @param {string} [args.context] extra signal (file paths touched, risk words, etc.)
 * @param {{safeEvaluate?: typeof safeEvaluate, piAvailable?: typeof piAvailable}} [deps] test seam — defaults to the real client/pi-run
 * @returns {Promise<{executor:string, confidence:number|null, source:'jev'|'fallback', reason?:string}>}
 */
export async function chooseExecutor({ root, task, context = "" }, deps = {}) {
  const evalFn = deps.safeEvaluate ?? safeEvaluate;
  const piCheck = deps.piAvailable ?? piAvailable;
  const cfg = resolveJevConfig(root);
  const fallback = { executor: DEFAULT_EXECUTOR, confidence: null, source: "fallback" };

  if (!cfg.enabled) return { ...fallback, reason: "jev disabled in maple.config.json" };

  const taskText = String(task ?? "");
  if (looksSensitive(taskText)) return { ...fallback, reason: "task text looked sensitive — not sent to Jev" };

  const state = {
    task: clip(redact(taskText), 900),
    context: clip(redact(String(context ?? "")), 300),
  };

  const result = await evalFn(root, state, QUESTION, { timeoutMs: cfg.timeoutMs });
  let outcome;
  if (!result) {
    outcome = { ...fallback, reason: "jev unavailable (no key / timeout / error) — fail-open" };
  } else {
    const choice = decide(result.answers?.executor, cfg.confidenceFloor);
    if (!choice || !EXECUTORS.includes(choice)) {
      outcome = { ...fallback, reason: "jev answer missing/low-confidence/unrecognized — fail-open" };
    } else if (choice === "pi" && !(await piCheck())) {
      outcome = { executor: DEFAULT_EXECUTOR, confidence: result.answers.executor.confidence, source: "fallback", reason: "jev chose pi but the Pi worker is unavailable — falling back to sonnet" };
    } else {
      outcome = { executor: choice, confidence: result.answers.executor.confidence, source: "jev" };
    }
  }

  logDecision(root, { kind: "route", ...outcome, taskPreview: clip(redact(taskText), 200) });
  return outcome;
}
