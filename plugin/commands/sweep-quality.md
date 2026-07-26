---
description: "Loop-pack: one verified quality improvement per cycle, budget-bounded"
---

# /sweep-quality — Loop-pack: one verified improvement per cycle

One unattended, budget-bounded cycle that reviews recent commits
(newest-first) for a bug, a simplification opportunity, or an untested
critical path, and lands exactly ONE small, verified improvement. Meant to
be invoked by `/dev-burner` as one of the loops it rotates through, or run
standalone under `/loop`. Full spec: [[loop-pack]] (this file implements its
`/sweep-quality` anatomy table exactly).

## Cross-cutting loop-pack rules (docs/loop-pack.md D005-D007 — every cycle)

- **External verification only** — the gate (and, for a new test, the
  red-green proof below) is the check, never this command's own say-so.
- **Hard budget, no free-running.** Read from `loops.budgetPerCycle`,
  enforced via `budget.mjs`. Hit the cap → stop, revert, log, hand back.
- **Standing branch only** — `repo.standingLoopBranch` (default
  `dev-burner`), never merged, never pushed.
- **No `docs/` page writes.**
- **Process corrections** go in the cycle report only.

## Config this command reads (`maple.config.json`)

| Key | Default | Notes |
|---|---|---|
| `ci.tiers.gate` | **required** | full gate command — unconfigured → refuse to commit, report and stop |
| `loops.budgetPerCycle.turns` / `.minutes` | `40` / `20` | this cycle's hard budget (enforced by this file's own `check` calls below) |
| `loops.budgetPerCycle.toolCalls` | `400` | mechanical guard's runaway backstop (`plugin/hooks/loop-budget-guard.mjs`) — RAW TOOL CALLS, a different unit than `.turns` |
| `repo.standingLoopBranch` | `"dev-burner"` | the branch every commit lands on |

Malformed config? `node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs"`.

## State: `.loop-state/sweep-quality.json`

Read/write via `plugin/scripts/loops/state.mjs`. Shape:

```json
{ "lastReviewedCommit": "sha|null", "discarded": { "<candidate-key>": { "ts": "ISO", "reason": "..." } } }
```

`lastReviewedCommit` is the walk cursor (newest-first from HEAD down) — the
NEXT cycle resumes just past it rather than re-reviewing the same commits
every time. `discarded` records a candidate that failed the gate this run
so it isn't retried blind within the same run.

## Steps

### 0. Setup

```bash
. "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-lib.sh"
maple_ensure_loop_state_gitignored   # covers a standalone /loop run too, not just /dev-burner (MJ-7)
GATE_CMD="$(maple_cfg ci.tiers.gate '')"
[ -n "$GATE_CMD" ] || maple_die "no ci.tiers.gate configured — refusing to commit ungated"
TURNS_LIMIT="$(maple_cfg loops.budgetPerCycle.turns 40)"
MINUTES_LIMIT="$(maple_cfg loops.budgetPerCycle.minutes 20)"
TOOL_CALL_LIMIT="$(maple_cfg loops.budgetPerCycle.toolCalls 400)"   # loop-budget-guard.mjs's own backstop — NOT the same unit as TURNS_LIMIT (B2)
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
ITER=0
node "$CLAUDE_PLUGIN_ROOT/scripts/loops/budget.mjs" start --loop sweep-quality \
  --limit "$TURNS_LIMIT" --minutes-limit "$MINUTES_LIMIT" --tool-call-limit "$TOOL_CALL_LIMIT" \
  --root "$MAPLE_REPO_ROOT"   # mechanical enforcement (MJ-8) — see loop-budget-guard.mjs; --root pins the write to THIS worktree (M4)
```

Load state: `node "$CLAUDE_PLUGIN_ROOT/scripts/loops/state.mjs" read sweep-quality --root "$MAPLE_REPO_ROOT"`.

### 1. Find a candidate

Walk `git log --oneline` newest-first from HEAD. If `lastReviewedCommit` is
set and still reachable, resume just past it; otherwise start from HEAD
(the cursor commit was rebased away — e.g. after a morning land + branch
recreation — so restart the walk cleanly rather than erroring).

For each commit walked (bounded by budget, see step 2), look for ONE of:

- **A bug** — read the diff, look for an off-by-one, an unhandled
  edge case, a swallowed error, a type escape hatch (`any`,
  `@ts-ignore`) introduced without justification.
- **A simplification** — dead code, duplicated logic that could be one
  function, an overcomplicated conditional, an unused export (`knip`-shaped
  findings) visible in that diff or its immediate neighborhood.
- **An untested critical path** — a diff that touches auth, payments,
  RLS/data-access, or another security/correctness-sensitive path with no
  corresponding test change.

Stop at the FIRST commit that yields a genuine, small candidate (diff/lines
capped — see "Budget" below) — this loop does not batch multiple findings
into one cycle. Nothing found after walking the whole reachable history
(cursor wraps back to HEAD) → outcome `quiet`.

### 2. Budget check, then apply

```bash
ITER=$((ITER+1))
node "$CLAUDE_PLUGIN_ROOT/scripts/loops/budget.mjs" check --used "$ITER" --limit "$TURNS_LIMIT" --started-at "$STARTED_AT" --minutes-limit "$MINUTES_LIMIT"
```

Exit 1 (exceeded) → outcome `budget-exceeded`, write `lastReviewedCommit` to
wherever the walk had reached (so the next cycle resumes, not restarts),
straight to "Report".

Otherwise, for the one candidate found:

1. `PRE_SHA="$(git rev-parse HEAD)"`.
2. Apply the ONE improvement — keep the diff small (a handful of files,
   reviewable in the morning; if it's ballooning into a redesign, discard
   it and record why in `discarded` rather than force a big diff through).
3. **If the candidate is a new test for an untested critical path**: first
   confirm the test is **red** (fails) against the code as it stood before
   this cycle's change — if there's no code change alongside it, temporarily
   verify the test actually exercises the path by checking it fails on a
   deliberately-broken version, or by inspecting coverage; then confirm
   **green** after. If the candidate is a bug fix, write a regression test
   for it using the same red-before-fix / green-after discipline as
   `/sweep-errors` step 2.3-2.5.
4. **Run the full gate** (`eval "$GATE_CMD"`).
   - **Gate red** → `git reset --hard "$PRE_SHA"`, record the candidate in
     `discarded` with the failure reason, try a different candidate next
     cycle (don't retry the same one blind within this run).
   - **Gate green** → `git add -A -- ':!.loop-state' && git commit -m "refactor(sweep-quality): <one-line summary>"`
     (or `fix(sweep-quality): ...` / `test(sweep-quality): ...` as fits;
     pathspec exclusion keeps `.loop-state/*.json` scratch out of the
     commit — MJ-7).
     Record the commit SHA for the report.
5. Update `lastReviewedCommit` to the commit that yielded this candidate
   (found or discarded — either way, don't re-review it) and write state.

### 3. Next-action logic

Continue the walk from `lastReviewedCommit`; skip anything already covered
or already in `discarded` this run. One improvement (or one budget-exceeded
stop) per cycle, always.

### 4. Report (always)

```bash
echo '{"ts":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'","loop":"sweep-quality","outcome":"<outcome>","commit":<commit-sha-json-string-or-null>,"budgetUsed":{"turns":'"$ITER"',"minutes":<elapsed>}}' \
  | node "$CLAUDE_PLUGIN_ROOT/scripts/loops/ledger.mjs" append --root "$MAPLE_REPO_ROOT"
node "$CLAUDE_PLUGIN_ROOT/scripts/loops/budget.mjs" end --root "$MAPLE_REPO_ROOT"   # clear the cycle file — loop-budget-guard.mjs goes back to no-op (MJ-8)
```

Summarize in chat: the candidate found (or "quiet"), what kind (bug /
simplification / test), commit SHA if any, diff size.

## Failure handling (summary)

Candidate fails the gate → discard it (`git reset --hard` to the pre-attempt
SHA), record it in `discarded` so it isn't retried blind this run, try a
different candidate next cycle.

## Gap vs. the spec

"Diff-size capped (files/lines)" has no hard numeric default in
docs/loop-pack.md — this command uses judgment ("a handful of files,
reviewable in the morning") rather than a fixed line-count gate. If that
proves too loose in practice, a concrete cap belongs in `sizeCaps.*` or a
new `loops.*` key, added the same way `weights`/`cooldownCycles` were
(docs/tasks.md #T8) — not invented ad hoc here.
