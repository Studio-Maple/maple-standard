---
description: "Loop-pack: find docs-vs-code drift, budget-bounded, gaps.md-only"
---

# /detect-drift — Loop-pack: semantic docs-vs-code drift, one cycle

One unattended, budget-bounded cycle that reads a rotating subset of
`docs/` pages and the code at their `code:` anchor paths, and writes up any
claim the docs make that the code no longer backs — as a proposal in
`docs/gaps.md` ONLY, never a doc-page edit. This is the ONE loop in the pack
with any docs-write privilege, scoped to exactly this. Meant to be invoked
by `/dev-burner` as one of the loops it rotates through, or run standalone
under `/loop`. Full spec: [[loop-pack]] (this file implements its
`/detect-drift` anatomy table exactly).

## Cross-cutting loop-pack rules (docs/loop-pack.md D005-D007 — every cycle)

- **External verification only** — the `gaps.md` edit must pass the
  structural drift gate; that's the check, not this command's own say-so.
- **Hard budget, no free-running.** Read from `loops.budgetPerCycle`,
  enforced via `budget.mjs`. Hit the cap → stop, revert, log, hand back.
- **Standing branch only** — `repo.standingLoopBranch` (default
  `dev-burner`), never merged, never pushed.
- **`docs.gaps` append is this loop's ONLY docs-write privilege.** No other
  `docs/` page — not `docs.index`, not `docs.decisions`, not `docs.tasks`,
  not the page under review — is ever edited by this loop. It never
  resolves the drift itself (that's `/burn-backlog` or a human's job); it
  only reports it.
- **Process corrections** go in the cycle report only.

## Config this command reads (`maple.config.json`)

| Key | Default | Notes |
|---|---|---|
| `docs.gaps` | `"docs/gaps.md"` | where every detected drift is appended |
| `docs.root` | `"docs"` | the rotation set — every `.md` file under here |
| `loops.budgetPerCycle.turns` / `.minutes` | `40` / `20` | this cycle's hard budget |
| `repo.standingLoopBranch` | `"dev-burner"` | the branch every commit lands on |

This loop's own verification uses the plugin's bundled
`plugin/scripts/docs/check-docs-drift.mjs` directly — no separate
`docs.driftScript` config key, and no `ci.tiers.gate` either (see "Scope
vs. the docs gate" below for why the check here is narrower than a full
code-change gate).

Malformed config? `node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs"`.

## State: `.loop-state/detect-drift.json`

Read/write via `plugin/scripts/loops/state.mjs`. Shape:

```json
{ "rotationCursor": "docs/loop-pack.md|null", "openGapKeys": ["<page>::<one-line summary>", "..."] }
```

`rotationCursor` is the last doc page reviewed (rotation resumes just past
it, wrapping to the start when it runs off the end). `openGapKeys` is a
dedup list against gaps this loop has already opened (scanned fresh from
`docs.gaps` each cycle, not trusted stale — a human may have resolved and
removed an entry since).

## Steps

### 0. Setup

```bash
. "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-lib.sh"
GAPS_FILE="$(maple_cfg docs.gaps docs/gaps.md)"
DOCS_ROOT="$(maple_cfg docs.root docs)"
TURNS_LIMIT="$(maple_cfg loops.budgetPerCycle.turns 40)"
MINUTES_LIMIT="$(maple_cfg loops.budgetPerCycle.minutes 20)"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
ITER=0
```

Load state: `node "$CLAUDE_PLUGIN_ROOT/scripts/loops/state.mjs" read detect-drift`.
Re-derive `openGapKeys` by reading the current `$GAPS_FILE` fresh (don't
trust the state file's copy — a human may have already resolved an entry).

### 1. Rotate to the next page(s)

List every `.md` file under `$DOCS_ROOT` in a stable sorted order. Resume
just past `rotationCursor` (wrap to the start if past the end or if the
cursor page no longer exists). Take N pages this cycle, budget permitting
(see step 2) — a handful per cycle is enough for a nightly rotation to cover
`docs/` over several nights without one cycle reading the whole tree.

### 2. Budget check, then review each page

```bash
ITER=$((ITER+1))
node "$CLAUDE_PLUGIN_ROOT/scripts/loops/budget.mjs" check --used "$ITER" --limit "$TURNS_LIMIT" --started-at "$STARTED_AT" --minutes-limit "$MINUTES_LIMIT"
```

Exit 1 (exceeded) → stop rotating, write `rotationCursor` to the last page
actually reviewed, outcome `budget-exceeded` (if at least one page was
reviewed and produced nothing) or the outcome from whatever was found so
far — "Report" below either way.

For each page:

1. Read the page's frontmatter `code:` anchors (or legacy `Code:`/`Enforced
   by:` paths) and the `authoritative_for` claims.
2. Read the code at each anchor path.
3. Compare: does the code still back what the doc claims — not just "does
   the path exist" (the structural gate already checks that), but "is the
   *behavior* the doc describes still what the code does"? E.g. a doc
   claiming "budget is enforced via turns and minutes" when the code has
   dropped the minutes check; a doc describing a step order the code no
   longer follows; a documented default that the code's actual default no
   longer matches.
4. Genuinely ambiguous whether something is drift or an intentional,
   not-yet-documented change → flag it with an explicit `low-confidence`
   note in the gaps entry rather than silently resolving the ambiguity
   either way.
5. Skip anything whose dedup key (`<page>::<one-line summary>`) is already
   in `openGapKeys`.
6. For each genuine new finding, compose ONE short gaps.md bullet (the
   existing `docs.gaps` entry-length cap applies — condensed, pointer-style,
   not a full writeup) and append it to `$GAPS_FILE`.

### 3. Verify the `gaps.md` edit (this loop's actual gate)

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/check-docs-drift.mjs"
```

- **Clean (0 errors)** → commit: `git add "$GAPS_FILE" && git commit -m "docs(detect-drift): flag N drift item(s) in gaps.md"`.
  Update `openGapKeys` with the new dedup keys, update `rotationCursor` to
  the last page reviewed, write state.
- **Errors** (e.g. the gaps entry exceeds the length cap) → do NOT commit;
  `git checkout -- "$GAPS_FILE"` to discard the bad edit, shorten/reformat
  and retry once within this cycle's budget; still red on retry → discard,
  record nothing for that page this cycle (don't leave a malformed edit
  sitting uncommitted), continue to the next page.

No findings across every page reviewed this cycle → outcome `quiet` (still
update `rotationCursor` — the rotation must keep moving even on a quiet
cycle, or it would re-read the same pages forever).

### 4. Next-action logic

Rotate forward through `docs/`; skip a page whose equivalent gap is already
open. One cycle's worth of pages reviewed + (zero or more) gaps.md commits,
always ending with `rotationCursor` advanced.

### 5. Report (always)

```bash
echo '{"ts":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'","loop":"detect-drift","outcome":"<outcome>","commit":<commit-sha-json-string-or-null>,"budgetUsed":{"turns":'"$ITER"',"minutes":<elapsed>}}' \
  | node "$CLAUDE_PLUGIN_ROOT/scripts/loops/ledger.mjs" append
```

Summarize in chat: pages reviewed, findings (with `low-confidence` flagged
separately), commit SHA if any.

## Failure handling (summary)

Ambiguous drift-vs-intentional → flag `low-confidence`, don't resolve it
either way. A `gaps.md` edit that fails the structural drift gate is
discarded (never committed malformed), retried once reformatted, then
dropped for that page this cycle if still red.

## Scope vs. the docs gate

This loop's "verification gate" is narrower than the other three loops' full
`ci.tiers.gate` — by design, since it makes no code changes, only appends
one file. Running the full code gate here would burn most of the cycle's
budget on a check that can't fail from a docs-only edit. The structural
drift script IS the real, external, non-self-graded check for this loop's
specific claim ("this gaps.md edit is well-formed and doesn't break the
docs gate") — consistent with D007 even though it's a different command
than `ci.tiers.gate`.
