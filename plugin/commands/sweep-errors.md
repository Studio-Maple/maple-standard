---
description: "Loop-pack: sweep tracked errors down to zero, budget-bounded"
---

# /sweep-errors — Loop-pack: tracker triage + fix, one cycle

One unattended, budget-bounded cycle of `/heal`-style error triage. Meant to
be invoked by `/dev-burner` as one of the loops it rotates through, or run
standalone under `/loop`. Full spec: [[loop-pack]] (this file implements
its `/sweep-errors` anatomy table exactly).

## Cross-cutting loop-pack rules (docs/loop-pack.md D005-D007 — every cycle)

- **External verification only.** The gate + the red-before-fix/green-after
  regression test are the check — never this command's own say-so.
- **Hard budget, no free-running.** Read from `loops.budgetPerCycle`,
  enforced via `budget.mjs` (see "Budget" below). Hit the cap → stop, revert
  any uncommitted/attempted work, log it, hand back to `/dev-burner`.
- **Standing branch only.** Everything happens in the standing worktree on
  `repo.standingLoopBranch` (default `dev-burner`) — never merged, never
  pushed. Landing is Maayan's call at morning review.
- **No `docs/` page writes.** This loop never edits a `docs/` content page.
- **Process corrections** (a rule this cycle didn't know it should have)
  go in the cycle report only — never self-applied to `CLAUDE.md`.

## Config this command reads (`maple.config.json`)

| Key | Default | Notes |
|---|---|---|
| `errorTracker.provider` / `.sentryProject` / `.endpoint` / `.readTokenRef` / `.writeTokenRef` | — | same tracker identity `/heal` uses |
| `errorTracker.query` | `"is:unresolved"` | issue-search query |
| `ci.tiers.gate` | **required** | the full gate command — no configured `gate` tier → refuse to commit, report and stop (never guess a substitute) |
| `loops.budgetPerCycle.turns` / `.minutes` | `40` / `20` | this cycle's hard budget (enforced by this file's own `check` calls below) |
| `loops.budgetPerCycle.toolCalls` | `400` | mechanical guard's runaway backstop (`plugin/hooks/loop-budget-guard.mjs`) — RAW TOOL CALLS, a different unit than `.turns` |
| `repo.standingLoopBranch` | `"dev-burner"` | the branch every commit lands on |

Malformed config? `node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs"`.

## State: `.loop-state/sweep-errors.json`

Read/write via `plugin/scripts/loops/state.mjs`. Shape:

```json
{ "fingerprints": { "<culprit>::<error_class>": { "outcome": "fixed|noise|unreproducible|budget-exceeded", "ts": "ISO" } } }
```

`fixed` fingerprints are skipped permanently for this branch's lifetime (a
recurrence is a NEW tracker event with a fresh `lastSeen`, `/heal`'s job at
that point, not this loop's). `noise` / `unreproducible` are skipped for 24
hours from `ts`, then eligible for retry (state, code, or the tracker may
have moved on). `budget-exceeded` is always eligible next cycle — it wasn't
actually attempted.

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
node "$CLAUDE_PLUGIN_ROOT/scripts/loops/budget.mjs" start --loop sweep-errors \
  --limit "$TURNS_LIMIT" --minutes-limit "$MINUTES_LIMIT" --tool-call-limit "$TOOL_CALL_LIMIT" \
  --root "$MAPLE_REPO_ROOT"   # mechanical enforcement (MJ-8) — see loop-budget-guard.mjs; --root pins the write to THIS worktree (M4)
```

Load state: `node "$CLAUDE_PLUGIN_ROOT/scripts/loops/state.mjs" read sweep-errors --root "$MAPLE_REPO_ROOT"`.

### 1. Fetch + cluster (reuses `/heal`'s logic)

Query the configured tracker exactly as `/heal` step 1 does (same
provider/project/endpoint/query, sorted by frequency). No issues → outcome
`quiet`, skip to "Report" below.

Cluster by `{culprit, error_class}` (drop replay-capture duplicates, same as
`/heal`). Apply `/heal`'s stale-check heuristics to drop stale clusters
before ranking.

Filter out any cluster whose fingerprint is in state with outcome `fixed`,
or `noise`/`unreproducible` less than 24h old. Rank the rest by frequency.

Nothing actionable left → outcome `quiet` → "Report" below.

### 2. Work up to 2 clusters, budget permitting

For each candidate cluster, up to 2 per cycle:

```bash
ITER=$((ITER+1))
node "$CLAUDE_PLUGIN_ROOT/scripts/loops/budget.mjs" check --used "$ITER" --limit "$TURNS_LIMIT" --started-at "$STARTED_AT" --minutes-limit "$MINUTES_LIMIT"
```

Exit 1 (exceeded) → stop the loop for this cycle: any in-progress edit gets
reverted (below), mark the in-progress fingerprint `budget-exceeded` in
state, write state, outcome `budget-exceeded` → "Report".

Otherwise, for this cluster:

1. **Reproduce** the top actionable cluster on a clean load — locate the bug
   (Grep the stack's file/function, Read surrounding code) same as `/heal`
   step 2. Reproduction fails after 1 retry with a fresh look → mark
   `unreproducible` in state, move to the next candidate (don't retry blind).
2. **Capture the pre-attempt commit**: `PRE_SHA="$(git rev-parse HEAD)"`.
3. **Write a regression test FIRST** and confirm it's **red** against the
   current (pre-fix) code — run just that test file/case, confirm it fails.
   If it doesn't fail, the reproduction is wrong — treat as unreproducible,
   discard the test, move on (never keep a green "regression" test, it
   proves nothing).
4. **Apply the fix.**
5. **Run the full gate** (`eval "$GATE_CMD"`), which re-runs the regression
   test among everything else — confirm it now passes (**green**) as part
   of a passing gate.
   - **Gate red** (including the regression test itself still failing) →
     `git reset --hard "$PRE_SHA"` (undo only this attempt, not earlier
     cycles' already-verified commits on this branch), record the diagnosis
     in state for this fingerprint (outcome stays absent — not fixed, not
     noise, just failed this attempt; it will be retried next eligible
     cycle since no cooldown applies to a plain gate failure), continue to
     the next candidate.
   - **Gate green** → `git add -A -- ':!.loop-state' && git commit -m "fix(sweep-errors): <cluster id/title> — <brief>"`
     (pathspec exclusion keeps `.loop-state/*.json` scratch out of the
     commit — MJ-7).
     Mark the fingerprint `fixed` in state. Record the commit SHA for the
     report.
6. Write state after every cluster (fixed, noise, unreproducible, or a bare
   failed-attempt) — never lose progress on a crash.

### 3. Next-action logic

- Fixed at least one cluster this cycle → outcome `fixed`.
- Nothing actionable was found at all → outcome `quiet`.
- Every actionable candidate failed the gate or was unreproducible, none
  fixed → outcome `noise` (nothing landed, but state now reflects why so
  the next cycle doesn't re-attempt them blind within cooldown).

### 4. Report (always — even on `quiet`/`budget-exceeded`)

```bash
echo '{"ts":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'","loop":"sweep-errors","outcome":"<outcome>","commit":<commit-sha-json-string-or-null>,"budgetUsed":{"turns":'"$ITER"',"minutes":<elapsed>}}' \
  | node "$CLAUDE_PLUGIN_ROOT/scripts/loops/ledger.mjs" append --root "$MAPLE_REPO_ROOT"
node "$CLAUDE_PLUGIN_ROOT/scripts/loops/budget.mjs" end --root "$MAPLE_REPO_ROOT"   # clear the cycle file — loop-budget-guard.mjs goes back to no-op (MJ-8)
```

Summarize in chat: outcome, clusters attempted/fixed/skipped, commit SHA(s)
if any, any process-correction candidates noticed this cycle (report only —
never self-applied).

## Failure handling (summary)

Gate-red → revert via `git reset --hard` to the pre-attempt SHA, log the
diagnosis to state, move to the next cluster. Reproduction failing after the
retry cap → mark `unreproducible`, skip it going forward (until the 24h
cooldown lapses), never retried blind.

## Gap vs. `/heal`

This loop deliberately does NOT run `/heal`'s T2-T5 verification ladder
(push/CI-watch, live deploy check, browser check, post-deploy tracker
recheck) — those assume a push to a real integration branch and a live
environment, neither of which exist for the standing `dev-burner` branch.
The gate tier (`ci.tiers.gate`) plus the red/green regression test is this
loop's entire verification ladder; the tracker itself only gets marked
resolved later, by a human-run `/heal` pass or at morning review, never by
this loop directly (it has no tracker-write permission and doesn't ask for
one — it isn't live enough to know the fix actually reached production).
