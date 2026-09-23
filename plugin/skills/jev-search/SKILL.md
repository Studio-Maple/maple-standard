---
name: jev-search
description: Use after any web/API search round, before opening results or spending another round. Jev decides which results are worth reading, whether the evidence found so far is sufficient, and which query (from ones you already wrote) to run next.
---

# Searching with Jev

A research turn is usually three decisions: which results to actually open,
whether what's been read is enough, and what to search next. Jev answers
both in one call, given the question, the results (title + snippet), the
queries already tried, and a short list of **candidate queries the caller
wrote** — Jev never invents a query, it only picks among the caller's own
candidates or says none of them would help. See
`plugin/scripts/jev/search.mjs`.

## When to use

After running a search (`WebSearch`, an MCP search tool, an API), before
deciding whether to open results, write the answer, or search again.

## How

```js
import { decideSearch } from "<plugin>/scripts/jev/search.mjs";

const out = await decideSearch({
  root: projectRoot,
  question: "what does the TypeSafe decision API cost",
  queriesTried: ["typesafe pricing"],
  candidateQueries: ["typesafe api pricing page", "systemone cost per request"],
  results: [{ id: "a", title: "...", url: "https://...", snippet: "..." }],
});
```

| `out.decision` | Meaning | What to do |
|---|---|---|
| `answer` | Results are sufficient (`out.sufficiency` is the confidence). | Read `out.selectedIds` and write the answer. Don't search again. |
| `search_more` | Not enough; Jev picked one of your `candidateQueries`. | Run `out.nextQuery` exactly, then call `decideSearch` again with the new results appended. |
| `propose_queries` | Not enough, and none of your candidates would help (or you gave none). | Write new candidate queries from what's missing and try again. |
| `unknown` | Jev wasn't consulted (unavailable, no results, sensitive question). | Decide yourself — nothing was claimed either way. |

## Guarantees

- **Jev never writes a query.** `nextQuery` is always a value from your own
  `candidateQueries`, or `null` — a hallucinated/out-of-list answer is
  discarded and treated as "propose new ones yourself".
- **Fail-open to `unknown`.** No credential, timeout, malformed reply, or a
  sensitive-looking question all resolve to `unknown` — proceed on your own
  judgment, not a false "insufficient" or "sufficient" verdict.
- **Redacted, capped payload.** Up to 12 results are sent, each with title
  and snippet clipped (~300 chars) and redacted; the question is clipped
  (~400 chars). A question that looks like it holds a secret is never sent.
- **Logged** to `.maple/jev-decisions.jsonl` (`kind: "search"`).

## What it is not

Not a search engine (it doesn't fetch anything — bring your own results),
not a summarizer (never returns prose, only ids and a decision), and not a
substitute for reading whatever you cite.

## Simplification vs. the ported reference

hermes-jev-skills' `jevkit/search.py` runs this as two pooled requests
(rank, then sufficiency+next-query) to amortize connection setup across a
high-volume fleet. This Node port asks both questions in one
`evaluate()` call — there's no shared-connection pool to optimize for in a
single Claude Code session. See `./NOTICE`.

## Config

Same `jev.*` block as `jev-model-routing` — see `plugin/README.md`.
