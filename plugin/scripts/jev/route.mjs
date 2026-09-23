#!/usr/bin/env node
/**
 * route.mjs — jev-model-routing skill's decision logic.
 *
 * Ports the ROUTING CONCEPT from hermes-jev-skills' jevkit/route.py (MIT —
 * see plugin/skills/jev-model-routing/NOTICE): ask Jev one CHOICE question
 * about how much executor a piece of work needs, act on the label only
 * when Jev is confident, and fail open to a safe default otherwise. This
 * is a from-scratch Node implementation, not a line-for-line port of the
 * multi-vendor OpenRouter pool machinery in jevkit/route.py.
 *
 * Owner decision (D058 — see plugin/README.md's Jev section): the burden
 * is INVERTED from the original design. The default executor is the
 * cheapest one — Pi on gpt-5.6-luna — whenever Pi is available and its
 * ChatGPT quota is open. Jev only picks a MORE expensive starting rung
 * (plugin/scripts/jev/ladder.mjs's PI_MODEL_LADDER) when it is confident
 * (>= ladder.ESCALATION_CONFIDENCE_FLOOR, 0.8) the task needs it:
 *
 *   small                                   -> pi/gpt-5.6-luna (the default)
 *   medium                                  -> pi/gpt-5.6-terra
 *   big / high-risk / production / security -> sonnet or opus (Jev's own call)
 *
 * Jev unavailable -> pi+luna if Pi is available, else sonnet (never opus —
 * opus is an escalation only Jev's confident judgment, or a real failed
 * validation climbing the ladder, should trigger).
 */
import { safeEvaluate, decide } from "./client.mjs";
import { resolveJevConfig } from "./config.mjs";
import { logDecision } from "./log.mjs";
import { clip, redact, looksSensitive } from "./redact.mjs";
import { piAvailable } from "./pi-run.mjs";
import { DEFAULT_PI_MODEL, DEFAULT_FALLBACK_MODEL, ESCALATION_CONFIDENCE_FLOOR, RUNG_CHOICES, startModelFor, isPiModel, nextRung } from "./ladder.mjs";

// Re-exported so callers that only need the ladder don't have to import two modules.
export { DEFAULT_PI_MODEL, DEFAULT_FALLBACK_MODEL, nextRung, isPiModel };

const QUESTION = {
  rung: {
    type: "choice",
    instructions:
      "A coding agent is about to delegate a task to a sub-agent. The DEFAULT " +
      "is the cheapest executor, 'pi-luna' — only pick something more expensive " +
      "when the task genuinely needs it. Choose the CHEAPEST rung that is still " +
      "capable of doing the task well.",
    criteria: RUNG_CHOICES,
  },
};

/**
 * @param {object} args
 * @param {string} args.root project root
 * @param {string} args.task the task/prompt about to be delegated
 * @param {string} [args.context] extra signal (file paths touched, risk words, etc.)
 * @param {{safeEvaluate?: typeof safeEvaluate, piAvailable?: typeof piAvailable}} [deps] test seam — defaults to the real client/pi-run
 * @returns {Promise<{model:string, kind:'pi'|'claude', confidence:number|null, source:'jev'|'fallback', reason?:string}>}
 *   `model` is a plugin/scripts/jev/ladder.mjs PI_MODEL_LADDER entry
 *   ("gpt-5.6-luna"/"gpt-5.6-terra"/"gpt-5.6-sol"/"sonnet"/"opus"). Run a Pi
 *   `kind` through pi-run.mjs's runPi({..., model}); run a Claude `kind`
 *   through the Agent/Task tool on that model.
 */
export async function chooseExecutor({ root, task, context = "" }, deps = {}) {
  const evalFn = deps.safeEvaluate ?? safeEvaluate;
  const piCheck = deps.piAvailable ?? piAvailable;
  const cfg = resolveJevConfig(root);

  const piUp = await piCheck();
  // The default whenever nothing overrides it: cheapest available rung.
  const defaultModel = piUp ? DEFAULT_PI_MODEL : DEFAULT_FALLBACK_MODEL;
  const toOutcome = (model, confidence, source, reason) => ({ model, kind: isPiModel(model) ? "pi" : "claude", confidence, source, ...(reason ? { reason } : {}) });
  const fallback = (confidence = null, reason) => toOutcome(defaultModel, confidence, "fallback", reason);

  if (!cfg.enabled) return log(root, task, fallback(null, "jev disabled in maple.config.json"));

  const taskText = String(task ?? "");
  if (looksSensitive(taskText)) return log(root, task, fallback(null, "task text looked sensitive — not sent to Jev"));

  const state = {
    task: clip(redact(taskText), 900),
    context: clip(redact(String(context ?? "")), 300),
  };

  const result = await evalFn(root, state, QUESTION, { timeoutMs: cfg.timeoutMs });
  if (!result) {
    return log(root, task, fallback(null, `jev unavailable — defaulting to ${defaultModel} (pi+luna if Pi is up, else sonnet; never opus on a fail-open path)`));
  }

  const answer = result.answers?.rung;
  const label = answer?.type === "choice" ? answer.choice : null;
  const confidence = typeof answer?.confidence === "number" ? answer.confidence : null;

  if (!label || !(label in RUNG_CHOICES)) {
    return log(root, task, fallback(confidence, "jev answer missing/unrecognized — fail-open to the default rung"));
  }

  if (label === "pi-luna") {
    // Confirms the default; no confidence gate needed either way.
    if (piUp) return log(root, task, toOutcome(DEFAULT_PI_MODEL, confidence, "jev"));
    return log(root, task, toOutcome(DEFAULT_FALLBACK_MODEL, confidence, "fallback", "jev chose pi-luna but Pi is unavailable — falling back to sonnet"));
  }

  // Any other label is an ESCALATION past the default — only trust it at the confidence floor.
  if (confidence === null || confidence < ESCALATION_CONFIDENCE_FLOOR) {
    return log(
      root,
      task,
      fallback(confidence, `jev suggested escalating to '${label}' but confidence ${confidence ?? "n/a"} < ${ESCALATION_CONFIDENCE_FLOOR} — staying on the default rung`),
    );
  }

  const model = startModelFor(label);
  if (isPiModel(model) && !piUp) {
    return log(root, task, toOutcome(DEFAULT_FALLBACK_MODEL, confidence, "fallback", `jev chose the Pi rung '${label}' but Pi is unavailable — falling back to sonnet`));
  }
  return log(root, task, toOutcome(model, confidence, "jev"));
}

function log(root, task, outcome) {
  // outcome.kind ('pi'|'claude') and the log record's own kind ('route') are
  // different axes — spread first, then set the log kind last so it isn't
  // clobbered by outcome.kind.
  logDecision(root, { ...outcome, taskPreview: clip(redact(String(task ?? "")), 200), execKind: outcome.kind, kind: "route" });
  return outcome;
}
