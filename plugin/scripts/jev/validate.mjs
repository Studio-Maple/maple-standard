#!/usr/bin/env node
/**
 * validate.mjs — the shared "did this agent actually do the task" judge.
 *
 * Used by two callers:
 *   - plugin/hooks/jev-validate-subagent.mjs (SubagentStop hook) — judges a
 *     Claude Code sub-agent's task prompt + final report.
 *   - plugin/scripts/jev/pi-run.mjs's caller (jev-model-routing's pi
 *     branch) — judges a headless Pi run's task prompt + summary before the
 *     main session trusts it, per the goal's "pi-run.mjs results go
 *     through the same validator before returning".
 *
 * Fail-open contract: any error, timeout, or low-confidence answer resolves
 * to "not blocked" — a buggy or unreachable judge must never trap a session.
 */
import { safeEvaluate, decide } from "./client.mjs";
import { resolveJevConfig } from "./config.mjs";
import { logDecision } from "./log.mjs";
import { clip, redact, looksSensitive } from "./redact.mjs";

const QUESTION = {
  done: {
    type: "choice",
    instructions:
      "A sub-agent was given a task and reported back. Using ONLY the task " +
      "and the report text below (you cannot see the actual files/diff), " +
      "judge: did the report describe completing the task, with evidence " +
      "(specific files, commands run, results) rather than vague claims or " +
      "a report that describes a DIFFERENT, smaller, or abandoned task? " +
      "'done' = the report plausibly completed the stated task with real " +
      "evidence. 'not_done' = the report is vague, contradicts the task, " +
      "describes only partial/abandoned work, or shows no evidence of the " +
      "claimed work.",
    criteria: {
      done: "The report plausibly completed the stated task with real evidence.",
      not_done: "The report is vague, contradicts the task, describes only partial/abandoned work, or shows no evidence of the claimed work.",
    },
  },
};

/**
 * @param {object} args
 * @param {string} args.root project root
 * @param {string} args.task the task/prompt the sub-agent was given
 * @param {string} args.report the sub-agent's final report/summary
 * @param {string} [args.kind] a label for the log ('subagent' | 'pi')
 * @param {{safeEvaluate?: typeof safeEvaluate}} [deps] test seam — defaults to the real client
 * @returns {Promise<{block:boolean, reason:string, confidence:number|null, source:'jev'|'fallback'}>}
 */
export async function judgeCompletion({ root, task, report, kind = "subagent" }, deps = {}) {
  const evalFn = deps.safeEvaluate ?? safeEvaluate;
  const cfg = resolveJevConfig(root);
  const allow = { block: false, reason: "", confidence: null, source: "fallback" };

  if (!cfg.enabled) return { ...allow, reason: "jev disabled" };

  const taskText = String(task ?? "");
  const reportText = String(report ?? "");
  if (!taskText.trim() || !reportText.trim()) return { ...allow, reason: "no task/report text to judge" };
  if (looksSensitive(taskText) || looksSensitive(reportText)) return { ...allow, reason: "task/report looked sensitive — not sent to Jev" };

  const state = {
    task: clip(redact(taskText), 1500),
    report: clip(redact(reportText), 1500),
  };

  const result = await evalFn(root, state, QUESTION, { timeoutMs: cfg.timeoutMs });
  let outcome;
  if (!result) {
    outcome = { ...allow, reason: "jev unavailable — fail-open" };
  } else {
    const answer = result.answers?.done;
    const choice = decide(answer, cfg.confidenceFloor);
    if (choice === "not_done") {
      outcome = {
        block: true,
        reason:
          "Jev judged this report as not clearly completing the task " +
          `(confidence ${answer.confidence.toFixed(2)}). Re-check the work against ` +
          "the original task and either finish it or explain what's left before stopping.",
        confidence: answer.confidence,
        source: "jev",
      };
    } else {
      outcome = { ...allow, confidence: answer?.confidence ?? null, source: choice ? "jev" : "fallback" };
    }
  }

  logDecision(root, { kind: `validate:${kind}`, ...outcome, taskPreview: clip(redact(taskText), 200) });
  return outcome;
}
