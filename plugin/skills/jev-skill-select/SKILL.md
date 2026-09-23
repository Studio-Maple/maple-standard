---
name: jev-skill-select
description: Use when several installed skills could plausibly apply to a request and it's not obvious which (or whether any) actually fits. Jev ranks the catalog by name+description and may say none apply, so a session doesn't load a skill by guesswork.
---

# Skill selection with Jev

Skill descriptions are written to be found by a keyword match, which means
two or three can look equally plausible for the same request. Jev reads the
request against the catalog (`name` + one-line `description` per skill) and
answers one typed CHOICE question: which skill, if any, clearly applies. See
`plugin/scripts/jev/skill-select.mjs`.

## When to use

When you're about to load a skill via `Skill` and more than one candidate
seems to fit, or you're unsure whether any of them really apply (versus just
being thematically related). Not needed for the common case — a request
that obviously and uniquely matches one skill's description doesn't need a
second opinion.

## How

```js
import { pickSkill } from "<plugin>/scripts/jev/skill-select.mjs";

const { skill, confidence, source, reason } = await pickSkill({
  root: projectRoot,
  request: "clean up this messy export and fix the header row",
  skills: [
    { name: "xlsx", description: "Work with spreadsheet files (.xlsx, .csv, .tsv)." },
    { name: "pdf", description: "Work with PDF files." },
    // ...the catalog available in THIS session
  ],
});
```

- `skill` is the matched skill's `name`, or `null` when nothing clearly
  applies (or Jev is unavailable).
- Only offer skills this session can actually load — build `skills` from
  the session's own available-skills listing, never a hypothetical larger
  catalog.
- A `null` result means "proceed without a skill", not "try again" — do
  not go hunting for one by other means.

## Guarantees

- **Fail-open to no suggestion.** Unavailable Jev, no clear match, or a
  choice that isn't actually in the given catalog (a hallucinated name) all
  resolve to `skill: null` — never a call to a skill the session doesn't
  have.
- **Confidence-gated**, same floor as every other jev.* call
  (`jev.confidenceFloor`, default 0.5).
- **Small, redacted payload.** The request text is clipped (~600 chars) and
  redacted; each skill description is clipped to ~200 chars. Sensitive-
  looking request text is never sent (falls back to no suggestion).
- **Logged** to `.maple/jev-decisions.jsonl` (`kind: "skill-select"`) —
  review with `node plugin/scripts/jev/report.mjs [root]`.

## Simplification vs. the ported reference

hermes-jev-skills' `jevkit/skillpick.py` batches catalogs of hundreds of
skills across hosts and services into parallel requests, then a second
round to double-check the top candidates. This Node port asks one CHOICE
question in a single request — a Claude Code session's own catalog is small
enough (Anthropic's documented practical guidance is dozens of skills, not
hundreds) that the batching/two-round-trip machinery isn't needed. See
`./NOTICE`.

## Config

Same `jev.*` block as `jev-model-routing` — see `plugin/README.md`.
