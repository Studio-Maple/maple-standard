#!/usr/bin/env node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideSearch } from "./search.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

function sandboxRoot() {
  return mkdtempSync(join(tmpdir(), "jev-search-"));
}

const results = [{ id: "a", title: "Jev pricing", snippet: "Jev costs a fraction of a cent per call." }];

async function run() {
  {
    const root = sandboxRoot();
    try {
      const out = await decideSearch(
        { root, question: "what does Jev cost", results },
        { safeEvaluate: async () => ({ answers: { sufficient: { type: "choice", choice: "yes", confidence: 0.9 } } }) },
      );
      check("answers when jev says the results are sufficient", out.decision === "answer" && out.selectedIds.includes("a"), JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  {
    const root = sandboxRoot();
    try {
      const out = await decideSearch(
        { root, question: "what does Jev cost", candidateQueries: ["jev pricing page", "typesafe cost"], results },
        {
          safeEvaluate: async () => ({
            answers: {
              sufficient: { type: "choice", choice: "no", confidence: 0.8 },
              next_query: { type: "choice", choice: "typesafe cost", confidence: 0.85 },
            },
          }),
        },
      );
      check("picks one of the caller's own candidate queries", out.decision === "search_more" && out.nextQuery === "typesafe cost", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Jev must never be able to invent a query outside the candidates.
  {
    const root = sandboxRoot();
    try {
      const out = await decideSearch(
        { root, question: "what does Jev cost", candidateQueries: ["jev pricing page"], results },
        {
          safeEvaluate: async () => ({
            answers: {
              sufficient: { type: "choice", choice: "no", confidence: 0.8 },
              next_query: { type: "choice", choice: "some invented query", confidence: 0.9 },
            },
          }),
        },
      );
      check("ignores a next_query answer outside the candidates", out.decision === "propose_queries" && out.nextQuery === null, JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  {
    const root = sandboxRoot();
    try {
      const out = await decideSearch({ root, question: "what does Jev cost", results: [] }, { safeEvaluate: async () => null });
      check("proposes queries with no results and no candidates to search", out.decision === "unknown", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  {
    const root = sandboxRoot();
    try {
      const out = await decideSearch({ root, question: "what does Jev cost", results }, { safeEvaluate: async () => null });
      check("fails open to unknown when jev is unavailable", out.decision === "unknown" && out.source === "fallback", JSON.stringify(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

run().then(() => {
  if (failed > 0) {
    console.error(`${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All search.mjs checks passed.");
});
