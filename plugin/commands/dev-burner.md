---
description: "Loop-pack orchestrator: rotates sweep-errors/burn-backlog/sweep-quality/detect-drift under /loop"
---

# /dev-burner — Loop-pack orchestrator

The standing-session entry point for the loop pack. Run under `/loop` (e.g.
`/loop /dev-burner`, self-paced — no fixed interval) so it cycles
indefinitely: each cycle, ensure the standing worktree is ready, check the
global budget, pick a loop, let it run its own procedure and budget, append
its ledger entry, and yield back to `/loop`. Full spec: [[loop-pack]] (this
file implements the orchestrator's 7 steps exactly).

`/dev-burner --report` skips all of the above and just prints the
morning-review summary (`ledger.mjs summarize`) — see "Report mode" below.

## Isolation (non-negotiable)

Everything below happens in the STANDING worktree on
`repo.standingLoopBranch` (default `"dev-burner"`) — the same worktree
machinery as `/wt-start`, just one long-lived branch instead of an ephemeral
`agent/<slug>` one, reused cycle over cycle instead of created fresh per
session. This command NEVER merges that branch into the target branch
itself and NEVER pushes it anywhere — landing (if any) is Maayan's explicit
call at morning review (docs/loop-pack.md "Morning review"), via a
`dev-burner`-aware variant of `/wt-land`'s discipline, not this command.

## Config this command reads (`maple.config.json`)

| Key | Default | Notes |
|---|---|---|
| `repo.standingLoopBranch` | `"dev-burner"` | the standing branch; never auto-merged |
| `repo.devBranch` / `repo.prodBranch` | detected / `"main"` | the tip the standing branch is created/rebased from (devBranch wins, D008) |
| `loops.enabled` | all 4 | which loops rotate — passed through to `pick-loop.mjs` |
| `loops.sessionCap.cycles` / `.hours` | unset (no cap) | plugin extension (docs/tasks.md #T8) — step 2's global budget; unset means the standing `/loop` session's own stop mechanism is the only ceiling |
| `errorTracker.*` | — | used only for the lightweight "new high-severity issues?" check that feeds sweep-errors' priority flag (step 3) |

Each loop's own `loops.budgetPerCycle` / `ci.tiers.gate` / etc. are read by
that loop's OWN command file, not duplicated here. Malformed config?
`node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs"`.

## Steps

### 1. Ensure the standing worktree + branch

```bash
DIR="$(bash "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-devburner.sh" ensure)"
```

This creates the worktree + branch from the fresh dev-branch tip on first
run, re-attaches a worktree if one was pruned but the branch survives, and
rebases onto the fresh dev-branch tip when (and only when) the branch is
clean at cycle start — reusing the SAME global lock `/wt-land` holds during
its own rebase→gate→push window, so the two can never interleave on the
same remote target. See `plugin/scripts/agent-wt/maple-devburner.sh`'s own
header for the exact recovery rules.

If this session isn't already inside `$DIR`, call **`EnterWorktree`** with
that path now (first run only — subsequent cycles are typically already
there since the standing session stays put across cycles). Confirm HEAD is
`repo.standingLoopBranch` before continuing.

**`.loop-state/` must be gitignored.** MJ-7: this used to be a manual
check right here in this orchestrator's prose, which meant a loop run
STANDALONE under plain `/loop` (never through `/dev-burner`) skipped it
entirely. The check now lives in `maple_ensure_loop_state_gitignored()`
(`plugin/scripts/agent-wt/maple-lib.sh`), called from step 0 of every loop
command file (`sweep-errors.md` / `burn-backlog.md` / `sweep-quality.md` /
`detect-drift.md`) — so it runs whichever loop step 5 below hands off to,
covering both the orchestrated and standalone paths with one mechanism.
Idempotent (only appends + commits if the line is genuinely missing); still
the only place any loop-pack code touches `.gitignore` (per docs/tasks.md
#T8's brief: "scripts never edit .gitignore silently").

### 2. Check the global budget

```bash
. "$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-lib.sh"
CAP_CYCLES="$(maple_cfg loops.sessionCap.cycles '')"
CAP_HOURS="$(maple_cfg loops.sessionCap.hours '')"
```

If BOTH are unset, skip straight to step 3 — no session cap configured, the
standing `/loop` session's own stop mechanism is the only ceiling (this
matches the loop pack's pre-spec note that `/dev-burner` "has no global
ceiling of its own" unless one is explicitly configured).

Otherwise:

1. Read/init the session marker: `node "$CLAUDE_PLUGIN_ROOT/scripts/loops/state.mjs" read dev-burner`
   (state shape `{ "sessionStartedAt": "ISO" }`). Missing → this is the
   first cycle since the worktree was (re)created — set `sessionStartedAt`
   to now and write it.
2. Count cycles so far this session:
   `node "$CLAUDE_PLUGIN_ROOT/scripts/loops/ledger.mjs" summarize --json`
   → `.totalCycles` (the ledger resets whenever the standing worktree is
   recreated after a land, so it naturally scopes to "this session").
3. ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/loops/budget.mjs" check \
     --used "$TOTAL_CYCLES" --limit "${CAP_CYCLES:-999999999}" \
     --started-at "$SESSION_STARTED_AT" --minutes-limit "$([ -n "$CAP_HOURS" ] && echo $((CAP_HOURS*60)) || echo 999999999)"
   ```
4. Exceeded (exit 1) → **no-op this invocation**: report status in chat
   (cycles used / cap, elapsed / cap) and stop — do NOT pick or run a loop,
   do NOT append a ledger entry (no loop ran). Control still returns to
   `/loop`, which will call `/dev-burner` again on its own pacing; each
   no-op invocation reports the same "capped" status until a human
   intervenes (raises the cap, lands + recreates the worktree, or stops
   `/loop`).

### 3. Pick a loop for this cycle

Optional lightweight tracker check first (never blocks the cycle if it
fails): if `errorTracker.provider`/`.sentryProject` are configured and the
matching MCP tool is available this session, a quick unresolved-issues query
scoped to high severity, filtered to events since the last cycle's
timestamp (from the ledger) — any hits → `--sweep-errors-priority`. Tracker
unreachable/not configured/no matching MCP tool → skip silently, flag
defaults false.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/loops/pick-loop.mjs" [--sweep-errors-priority]
```

Prints `{"loop": "...", "reason": "...", "candidates": [...]}`. That's the
loop for this cycle.

### 4. Per-loop budget

Not re-implemented here — the chosen loop's OWN command file (step 0/2 of
each of `sweep-errors.md` / `burn-backlog.md` / `sweep-quality.md` /
`detect-drift.md`) reads `loops.budgetPerCycle` and enforces it via
`budget.mjs` itself, hard-stopping and reverting on overrun. This
orchestrator trusts that — duplicating the check here would just be a
second, redundant budget with its own drift risk.

### 5. Run the chosen loop's procedure

Follow that loop's command file's **Steps** section now, in this same
worktree/session — exactly as if `/sweep-errors` (or whichever was picked)
had been invoked directly. Its cross-cutting rules (no docs writes except
detect-drift's scoped exception, burn-backlog never checks off tasks.md,
process corrections stay in the report, standing-branch-only, never merged)
apply in full.

### 6. Ledger entry

Already handled — every loop command's own final "Report" step appends its
ledger entry via `ledger.mjs append` before returning here (this is what
makes each loop self-sufficient whether it's run standalone under `/loop`
or orchestrated by `/dev-burner`). This step is a CONFIRMATION, not a
second write: verify the ledger's last line matches the loop just run
(same `loop` name, a `ts` from this cycle) — if it's missing, that loop's
command file has a bug; report it rather than fabricating an entry here.

### 7. Yield

Report a one-line cycle summary in chat (loop, outcome, commit if any) and
end the turn — `/loop`'s self-pacing decides when the next cycle starts.
No fixed interval is enforced here.

## Report mode (`/dev-burner --report`)

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/loops/ledger.mjs" summarize
```

Prints the morning-review summary: cycle count, per-loop breakdown
(count + outcome tally), and every commit landed on the standing branch
this run. This is read-only — it never picks, runs, or commits anything.
Use it at the start of morning review (docs/loop-pack.md step 1) before
walking `git log development..dev-burner` commit by commit.

## Gap vs. the pre-spec stub

The original stub explicitly said `/dev-burner` "has no global ceiling of
its own... the human stops it via the normal `/loop` stop mechanism, not a
budget baked in here." docs/loop-pack.md's orchestrator step 2 ("check the
global budget... don't burn cycles past the configured overnight window")
supersedes that — this file implements the real spec, with the session cap
OPT-IN via `loops.sessionCap.*` so an unconfigured project keeps the
original stub's behavior (no cap) by default.
