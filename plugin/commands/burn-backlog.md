---
description: "Loop-pack: burn down docs/tasks.md, budget-bounded"
---

# /burn-backlog — Loop-pack: one specced task per cycle

One unattended, budget-bounded cycle that picks up ONE small, well-specified
open task from `docs.tasks` and implements + tests + verifies it. Meant to
be invoked by `/dev-burner` as one of the loops it rotates through, or run
standalone under `/loop`. Full spec: [[loop-pack]] (this file implements its
`/burn-backlog` anatomy table exactly).

## Cross-cutting loop-pack rules (docs/loop-pack.md D005-D007 — every cycle)

- **External verification only** — the gate is the check, never this
  command's own say-so.
- **Hard budget, no free-running.** Read from `loops.budgetPerCycle`,
  enforced via `budget.mjs`. Hit the cap → stop, revert, log, hand back.
- **Standing branch only** — `repo.standingLoopBranch` (default
  `dev-burner`), never merged, never pushed.
- **No `docs/` page writes**, including `docs.tasks` itself.
- **NEVER checks off `docs/tasks.md`.** This loop commits the working code +
  tests and records the completion claim in its OWN state file only. The
  actual `- [ ]` → `- [x]` sweep happens at morning review, evidence
  (commit SHA, gate result) in hand — see docs/loop-pack.md "Docs and rules
  discipline". Do not touch `docs.tasks` under any circumstance.
- **Process corrections** go in the cycle report only.

## Config this command reads (`maple.config.json`)

| Key | Default | Notes |
|---|---|---|
| `docs.tasks` | `"docs/tasks.md"` | the backlog to read (read-only — never written) |
| `ci.tiers.gate` | **required** | full gate command — unconfigured → refuse to commit, report and stop |
| `loops.budgetPerCycle.turns` / `.minutes` | `40` / `20` | this cycle's hard budget (enforced by this file's own `check` calls below) |
| `loops.budgetPerCycle.toolCalls` | `400` | mechanical guard's runaway backstop (`plugin/hooks/loop-budget-guard.mjs`) — RAW TOOL CALLS, a different unit than `.turns` |
| `repo.standingLoopBranch` | `"dev-burner"` | the branch every commit lands on |

Malformed config? `node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs"`.

## State: `.loop-state/burn-backlog.json`

Read/write via `plugin/scripts/loops/state.mjs`. Shape:

```json
{ "tasks": { "#T12": { "outcome": "done|failed|underspecified", "ts": "ISO", "commit": "sha|null" } } }
```

`done` this run → never re-attempted (it's a completion CLAIM pending
morning checkoff, not a guess — don't re-implement it a second time just
because `tasks.md` still shows it open). `failed` this run without a new
fix angle → skipped for the rest of THIS run (a later run may retry once
something's changed — this loop doesn't persist a time-based cooldown for
`failed`/`underspecified`, unlike sweep-errors's fingerprint cooldown,
because a task's blocker doesn't resolve itself with the clock the way
tracker noise might; it needs either a task-file edit or a fix idea).

## Steps

### 0. Setup

```bash
. "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-lib.sh"
maple_ensure_loop_state_gitignored   # covers a standalone /loop run too, not just /dev-burner (MJ-7)
GATE_CMD="$(maple_cfg ci.tiers.gate '')"
[ -n "$GATE_CMD" ] || maple_die "no ci.tiers.gate configured — refusing to commit ungated"
TASKS_FILE="$(maple_cfg docs.tasks docs/tasks.md)"
TURNS_LIMIT="$(maple_cfg loops.budgetPerCycle.turns 40)"
MINUTES_LIMIT="$(maple_cfg loops.budgetPerCycle.minutes 20)"
TOOL_CALL_LIMIT="$(maple_cfg loops.budgetPerCycle.toolCalls 400)"   # loop-budget-guard.mjs's own backstop — NOT the same unit as TURNS_LIMIT (B2)
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
ITER=0
node "$CLAUDE_PLUGIN_ROOT/scripts/loops/budget.mjs" start --loop burn-backlog \
  --limit "$TURNS_LIMIT" --minutes-limit "$MINUTES_LIMIT" --tool-call-limit "$TOOL_CALL_LIMIT" \
  --root "$MAPLE_REPO_ROOT"   # mechanical enforcement (MJ-8) — see loop-budget-guard.mjs; --root pins the write to THIS worktree (M4)
```

Load state: `node "$CLAUDE_PLUGIN_ROOT/scripts/loops/state.mjs" read burn-backlog --root "$MAPLE_REPO_ROOT"`.

### 1. Pick a task

Read `$TASKS_FILE`. Consider only OPEN (`- [ ]`) entries. From those, filter
to entries that are **concrete and actionable**:

- A clear, single-sentence-or-two scope with no open question inside it.
- Not tagged `blocked` and not phrased as a question.
- Not already `done`/`failed`/`underspecified` in this run's state.

Anything vague or blocked is skipped, not guessed at — this loop does not
invent scope. Pick the FIRST eligible task in file order (deterministic,
matches how a human would work the list top to bottom).

No eligible task → outcome `quiet` → "Report" below.

### 2. Budget check, then implement

```bash
ITER=$((ITER+1))
node "$CLAUDE_PLUGIN_ROOT/scripts/loops/budget.mjs" check --used "$ITER" --limit "$TURNS_LIMIT" --started-at "$STARTED_AT" --minutes-limit "$MINUTES_LIMIT"
```

Exit 1 (exceeded) before starting → outcome `budget-exceeded`, nothing
attempted, straight to "Report".

Otherwise:

1. `PRE_SHA="$(git rev-parse HEAD)"`.
2. Implement the task's stated scope. Write/extend tests that exercise it.
3. Discovered mid-implementation that the task is actually underspecified
   (real ambiguity only a human can resolve, not something Grep/Read can
   settle) → abort cleanly: `git reset --hard "$PRE_SHA"`, record
   `outcome: "underspecified"` with a one-line reason in state, flag it in
   the cycle report for morning review. Do not guess at scope to force a
   commit.
4. Re-check the budget before running the gate (a long implementation may
   have crossed the cap):
   ```bash
   ITER=$((ITER+1))
   node "$CLAUDE_PLUGIN_ROOT/scripts/loops/budget.mjs" check --used "$ITER" --limit "$TURNS_LIMIT" --started-at "$STARTED_AT" --minutes-limit "$MINUTES_LIMIT"
   ```
   Exceeded → `git reset --hard "$PRE_SHA"`, `outcome: "budget-exceeded"`,
   report; the task stays open for a future cycle with a fresh budget.
5. **Run the full gate** (`eval "$GATE_CMD"`).
   - **Gate red** → `git reset --hard "$PRE_SHA"`, record `outcome:
     "failed"` + the gate's failing step in state, task stays open in
     `tasks.md` (never marked done without a passing gate).
   - **Gate green** → `git add -A -- ':!.loop-state' && git commit -m "feat(burn-backlog): <#T id> — <brief>"`
     (the pathspec exclusion keeps this loop's own `.loop-state/*.json`
     scratch files — gitignored, but `-A` would still stage an untracked one
     if the gitignore-ensure step above hasn't run yet in this worktree —
     out of the commit; MJ-7).
     Record `outcome: "done"` + the commit SHA in state — this is a
     completion CLAIM, not a `tasks.md` checkoff (see rules above).
6. Write state.

### 3. Next-action logic

One task per cycle, always. `done` → outcome `done`. `failed` /
`underspecified` / `budget-exceeded` → outcome matches. No eligible task at
all → outcome `quiet`.

### 4. Report (always)

```bash
echo '{"ts":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'","loop":"burn-backlog","outcome":"<outcome>","commit":<commit-sha-json-string-or-null>,"budgetUsed":{"turns":'"$ITER"',"minutes":<elapsed>}}' \
  | node "$CLAUDE_PLUGIN_ROOT/scripts/loops/ledger.mjs" append --root "$MAPLE_REPO_ROOT"
node "$CLAUDE_PLUGIN_ROOT/scripts/loops/budget.mjs" end --root "$MAPLE_REPO_ROOT"   # clear the cycle file — loop-budget-guard.mjs goes back to no-op (MJ-8)
```

Summarize in chat: which `#T` id, outcome, commit SHA if any, and — for
`underspecified` — the specific ambiguity found, so morning review can
resolve it once instead of the loop guessing wrong twice.

## Failure handling (summary)

Gate-red → revert to the pre-attempt SHA via `git reset --hard`, record the
diagnosis, leave the task open — never marked done without a passing gate.
Underspecified mid-implementation → abort cleanly, flag for morning review
rather than guessing at scope.

## Gap vs. the spec

"Concrete and actionable" is a judgment call this command makes per-cycle,
same as `/heal`'s stale-check heuristics are a judgment call — there's no
tag/label convention in `docs/tasks.md` today that mechanically marks a task
loop-safe. If tasks.md gains such a convention later (e.g. an explicit
`#loop-safe` tag), this section should switch to reading it instead of
inferring.
