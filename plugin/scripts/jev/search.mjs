#!/usr/bin/env node
/**
 * search.mjs — jev-search skill's decision logic.
 *
 * Concept ported from hermes-jev-skills' jevkit/search.py (MIT — see
 * plugin/skills/jev-search/NOTICE): after a search round, ask Jev (1) which
 * results are worth reading and whether they're enough, and (2) if not,
 * which of the caller's own candidate queries to run next. Jev never
 * writes a query — the caller always supplies `candidateQueries`.
 *
 * This is a one-request simplification of jevkit/search.py's two-request
 * design (rank, then sufficiency+next-query) — both questions are asked in
 * a single evaluate() call here, since this plugin has no shared-connection
 * pooling concern to amortize across separate requests. See plugin/README.md's
 * Jev section "Gap" note.
 */
import { safeEvaluate, decide } from "./client.mjs";
import { resolveJevConfig } from "./config.mjs";
import { logDecision } from "./log.mjs";
import { clip, redact, looksSensitive } from "./redact.mjs";

const MAX_RESULTS = 12;

/**
 * @param {object} args
 * @param {string} args.root
 * @param {string} args.question the research question
 * @param {string[]} [args.queriesTried]
 * @param {string[]} [args.candidateQueries] queries the CALLER wrote — Jev only picks among these
 * @param {{id:string, title:string, url:string, snippet:string}[]} args.results
 * @param {{safeEvaluate?: typeof safeEvaluate}} [deps] test seam
 * @returns {Promise<{decision:'answer'|'search_more'|'propose_queries'|'answer_from_what_we_have'|'unknown', selectedIds:string[], nextQuery:string|null, sufficiency:number|null, source:'jev'|'fallback', reason?:string}>}
 */
export async function decideSearch({ root, question, queriesTried = [], candidateQueries = [], results = [] }, deps = {}) {
  const evalFn = deps.safeEvaluate ?? safeEvaluate;
  const cfg = resolveJevConfig(root);
  const unknown = { decision: "unknown", selectedIds: [], nextQuery: null, sufficiency: null, source: "fallback" };

  if (!cfg.enabled) return { ...unknown, reason: "jev disabled" };

  const questionText = String(question ?? "");
  if (looksSensitive(questionText)) return { ...unknown, reason: "question looked sensitive — not sent to Jev" };
  if (!Array.isArray(results) || results.length === 0) {
    return candidateQueries.length
      ? { ...unknown, decision: "propose_queries", reason: "no results to judge" }
      : { ...unknown, reason: "no results and no candidate queries" };
  }

  const trimmed = results.slice(0, MAX_RESULTS).map((r) => ({
    id: String(r.id),
    title: clip(redact(String(r.title ?? "")), 150),
    snippet: clip(redact(String(r.snippet ?? "")), 300),
  }));
  const ids = trimmed.map((r) => r.id);

  const questions = {
    sufficient: {
      type: "choice",
      instructions:
        "Given the research question and the search results (title + snippet) " +
        "below, is there ALREADY enough evidence in these results to answer the " +
        "question well? 'yes' = the results, taken together, clearly answer it. " +
        "'no' = the results are thin, off-topic, or contradictory and another " +
        "round is needed.",
      criteria: {
        yes: "The results, taken together, clearly answer the question.",
        no: "The results are thin, off-topic, or contradictory — another round is needed.",
      },
    },
  };
  if (candidateQueries.length > 0) {
    // "choice" wants {label: description} — each candidate query IS both
    // the label Jev returns and its own description here.
    const queryCriteria = Object.fromEntries(candidateQueries.map((q) => [q, q]));
    questions.next_query = {
      type: "choice",
      instructions:
        "If another search round is needed, which of these candidate queries " +
        "(written by the caller — never invent a new one) is most likely to " +
        "add NEW evidence not already covered by the queries already tried?",
      criteria: { ...queryCriteria, none: "None of the candidate queries would add new evidence." },
    };
  }

  const state = {
    question: clip(redact(questionText), 400),
    queriesTried: queriesTried.slice(0, 10).map((q) => clip(redact(String(q)), 100)),
    results: trimmed,
  };

  const result = await evalFn(root, state, questions, { timeoutMs: cfg.timeoutMs });
  let outcome;
  if (!result) {
    outcome = { ...unknown, reason: "jev unavailable — fail-open" };
  } else {
    const sufficientChoice = decide(result.answers?.sufficient, cfg.confidenceFloor);
    const sufficiency = result.answers?.sufficient?.confidence ?? null;
    if (sufficientChoice === "yes") {
      outcome = { decision: "answer", selectedIds: ids, nextQuery: null, sufficiency, source: "jev" };
    } else {
      const nextQuery = questions.next_query ? decide(result.answers?.next_query, cfg.confidenceFloor) : null;
      if (nextQuery && nextQuery !== "none" && candidateQueries.includes(nextQuery)) {
        outcome = { decision: "search_more", selectedIds: ids, nextQuery, sufficiency, source: "jev" };
      } else {
        outcome = { decision: "propose_queries", selectedIds: ids, nextQuery: null, sufficiency, source: "jev" };
      }
    }
  }

  logDecision(root, { kind: "search", ...outcome, questionPreview: clip(redact(questionText), 150) });
  return outcome;
}
