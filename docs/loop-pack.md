---
type: spec
title: Loop pack — autonomous overnight improvement loops
description: the dev-burner overnight loop pack, four autonomous loops, the orchestrator, morning review.
tags: [loop-pack, automation]
timestamp: 2026-07-25
audience: anyone running, extending, or reviewing the output of the standing loop session
authoritative_for: [the anatomy of each loop, the /dev-burner orchestrator, and the morning-review flow]
code: [plugin/commands/dev-burner.md, plugin/commands/{sweep-errors,burn-backlog,sweep-quality,detect-drift}.md]
---
# Loop pack — autonomous overnight improvement loops

> **Status:** Approved 2026-07-25 (owner sign-off). Spec for plugin v1 — implementation tracked in [[tasks]] and [[decisions]]. `code` above is stubs — implementation is #T8.
> **Related:** [[standard-architecture]] (plugin split, `maple.config.json`) · [[maplelens]] (the tracker `/sweep-errors` reads) · [[rollout]]

## What this is, per Cherny's loop-engineering framing

A loop is not "leave Claude running and hope." It's a worker that gets re-prompted against a goal, graded by something outside itself, and stopped by a budget — never by its own say-so. Four principles are load-bearing across every loop below and are not negotiable per-loop:

1. **The worker never grades its own homework.** Every loop's "done" claim is checked by something external — a build, a test suite, a lint pass, or (for `/sweep-errors`) the tracker actually going quiet. A loop asserting "fixed" with no external check is a bug in the loop, not a valid outcome.
2. **Every loop has a hard budget.** Turn cap and/or iteration cap, read from `maple.config.json` `loops.budgetPerCycle`. Hit the cap → stop, revert uncommitted work, log it. No loop free-runs.
3. **Every caught mistake becomes permanent.** A verification failure that traces to a *process* gap (the loop didn't know a rule it should have) gets written up as a correction candidate for `CLAUDE.md` or a skill — queued for morning review, never self-applied (see "Docs and rules discipline" below).
4. **Loops terminate at the branch, never at production.** Every loop's furthest reach is a commit on the standing `dev-burner` branch. Nothing here ever pushes to `development`, opens a PR against it, or touches prod.

## Standing execution model (shared by all four loops)

- **One long-running local session**, started by Maayan, running `/loop` self-paced (no fixed interval — the session paces itself) over `/dev-burner`. No Telegram reporting from this session.
- **One standing worktree, one standing branch.** Unlike `wt-start`'s ephemeral `agent/<slug>` worktrees, the loop pack uses a single dedicated worktree (e.g. `<repo>-loop`) checked out on a branch literally named `dev-burner`, created once from the current `development` tip and reused cycle over cycle — commits accumulate on it across the whole overnight run.
- **Full gate before every commit.** Whatever `maple.config.json` `ci.tiers.gate` resolves to (VeHagita's T1–T5 evidence-ladder pattern where a project has one) must pass before a loop's change is committed. A red gate reverts the attempt; it never lands half-verified.
- **`dev-burner` is never merged automatically.** Maayan reviews it each morning and lands it himself. See "Morning review" below.

## Docs and rules discipline (cross-cutting, applies to all four loops)

The owner-approval gate on `docs/` is absolute and this doesn't get relaxed for autonomous runs — if anything it gets stricter, because there's no one in the loop to catch an overreach in real time.

- **No loop edits a `docs/` content page directly**, except `/detect-drift`'s narrow, explicitly-granted `gaps.md`-append privilege (below). `decisions.md` entries are owner calls by definition — no loop writes one.
- **`/burn-backlog` does not check off `tasks.md` itself.** It commits the working code + tests and records the completion claim in its own state file; the actual tasks.md sweep happens at morning review, evidence in hand.
- **Process corrections** (principle 3 above) are written to the loop's report, not to `CLAUDE.md` — Maayan folds them in himself during review.

## The four loops

### `/sweep-errors`

| | |
|---|---|
| **Trigger** | Selected by `/dev-burner` for a cycle. |
| **Scope** | Unresolved issues from MapleLens (or Sentry, until MapleLens is deployed for this project — provider comes from `maple.config.json` `errorTracker.provider`). |
| **Action** | Pull unresolved issues → cluster actionable vs. noise (same discriminators as VeHagita's `/heal`: group by `{culprit, error_class}`, drop stale clusters via the stale-check heuristics) → reproduce the top actionable cluster on a clean load → fix with a regression test that is proven red-before-fix. |
| **Budget** | 1–2 clusters per cycle (config-capped) — small, verifiable changes over broad sweeps. |
| **Verification gate** | Full gate tier, plus the regression test must demonstrably fail against the pre-fix code and pass against the post-fix code — not just exist. |
| **State persistence** | `.loop-state/sweep-errors.json` — fingerprint → last outcome (`fixed` / `noise` / `unreproducible` / `budget-exceeded`) + timestamp, so noise isn't re-attempted every cycle. |
| **Next-action logic** | Skip fingerprints already resolved this run or marked noise within a cooldown window; if nothing actionable remains, report "quiet" and yield the cycle back to `/dev-burner`. |
| **Failure handling** | Gate-red → revert, log diagnosis to state, move to the next cluster. Reproduction failing after the retry cap → mark `unreproducible`, skip going forward, never retried blind. |

### `/burn-backlog`

| | |
|---|---|
| **Trigger** | Selected by `/dev-burner` for a cycle. |
| **Scope** | Small, well-specified tasks from `maple.config.json` `docs.tasks` — explicitly filtered to concrete, actionable entries; anything vague or tagged blocked is skipped, not guessed at. |
| **Action** | Implement the task, write/run tests, verify. |
| **Budget** | 1 task per cycle. |
| **Verification gate** | Full gate tier. |
| **State persistence** | `.loop-state/burn-backlog.json` — attempted `#T###` → outcome this run, plus a claim marker with timestamp so an overnight loop and Maayan working the same list by hand don't collide. |
| **Next-action logic** | Skip claimed/in-progress tasks; skip a task that failed once this run without a new fix angle. |
| **Failure handling** | Gate-red → revert, record diagnosis, leave the task open — never marked done without a passing gate. Discovered-underspecified mid-implementation → abort cleanly, flag it in the loop report for morning review rather than guessing at scope. |

### `/sweep-quality`

| | |
|---|---|
| **Trigger** | Selected by `/dev-burner` for a cycle. |
| **Scope** | Recent commits (newest-first) for bugs or simplification opportunities, plus untested critical paths. |
| **Action** | One small, verified improvement per cycle: a simplification, a bug fix, or a new test for an untested critical path. |
| **Budget** | 1 improvement per cycle, diff-size capped (files/lines) so it stays reviewable in the morning. |
| **Verification gate** | Full gate tier. For a new test specifically: prove it fails against the current code before the fix/instrumentation and passes after — red-green, not a self-assessment. |
| **State persistence** | `.loop-state/sweep-quality.json` — commits/files already reviewed, walked newest-first so it doesn't re-review the same commit every cycle. |
| **Next-action logic** | Continue the walk from the last reviewed commit; skip anything already covered. |
| **Failure handling** | Candidate fails gate → discard, try a different candidate next cycle, record the discard so it isn't retried blind. |

### `/detect-drift`

| | |
|---|---|
| **Trigger** | Selected by `/dev-burner` for a cycle. |
| **Scope** | Semantic docs-vs-code drift — claims a doc makes that the code no longer backs, beyond what the structural drift gate (dead paths, broken wikilinks) already catches. A rotating subset of `docs/` pages per cycle, bounded by budget. |
| **Action** | Read a doc page and the code at its `Code:` anchor paths; where they disagree, write a proposal into `docs/gaps.md` **only** — never edit the doc page itself. This is the one loop with any docs-write privilege, and it's scoped to exactly this. |
| **Budget** | N doc pages per cycle (config). |
| **Verification gate** | No code changes, so the check is narrower: the `gaps.md` edit itself must pass the structural drift gate and the entry-length/format convention. Still commits on `dev-burner` under the same discipline as every other loop. |
| **State persistence** | `.loop-state/detect-drift.json` — rotation cursor (last doc reviewed) + dedup list against gaps already open, so the same drift isn't re-flagged every cycle. |
| **Next-action logic** | Rotate forward through `docs/`; skip a page if an equivalent gap is already open. |
| **Failure handling** | Genuinely ambiguous whether something is drift or intentional → flag it with an explicit low-confidence note rather than silently resolving the ambiguity either way. |

## The orchestrator — `/dev-burner`

Run each cycle by the standing `/loop` session. No arguments needed for normal operation; optional flags to force a specific loop or bias selection for a one-off run.

1. **Ensure the standing worktree + `dev-burner` branch exist**, creating from the current `development` tip on first run. Rebase onto fresh `development` only at the start of a cycle when the branch tree is clean — never mid-cycle.
2. **Check the global budget.** If the session-level cap (cycles or wall-clock hours) is exhausted, no-op and report status; don't burn cycles past the configured overnight window.
3. **Pick a loop for this cycle.** Default: round-robin, weighted by config; a loop that reported "quiet" recently gets a cooldown so it doesn't hog cycles doing nothing. `/sweep-errors` gets priority if the tracker shows new high-severity issues since the last cycle.
4. **Enforce the per-loop budget** (principle 2) — hard stop, revert, log if exceeded mid-cycle.
5. **Run the chosen loop's procedure** as specified above.
6. **Append a ledger entry** to `.loop-state/dev-burner-ledger.jsonl` — one line per cycle: timestamp, loop chosen, outcome, commit SHA (if any), budget consumed. This is the primary artifact the morning review reads.
7. Yield back to `/loop`'s self-pacing for the next cycle.

## Morning review

1. Maayan reads `.loop-state/dev-burner-ledger.jsonl` — cycle count, commits landed on `dev-burner`, per-loop breakdown.
2. Reads each loop's queued report: `/detect-drift`'s already-committed `gaps.md` proposals, `/burn-backlog`'s completion claims (pending `tasks.md` checkoff), any process-correction candidates.
3. Reviews `git log development..dev-burner` / the diff, commit by commit. Per commit: land, discuss/amend, or discard.
4. **Landing** approved commits into `development` runs through the sanctioned integration path (a `dev-burner`-aware variant of `/wt-land`'s discipline: rebase onto fresh `development`, re-run the gate tier, fast-forward — never a bare merge that skips the gate a second time). This step is always explicit and always Maayan's call — nothing here auto-lands.
5. Docs bookkeeping — `tasks.md` checkoffs, any `decisions.md` entries for process corrections — happens now, informed by the loop's proposals but written by Maayan (or Claude Code under his direction in an interactive session), never by the loop itself.
6. After a successful land, recreate `dev-burner` from the new `development` tip for a clean slate rather than carrying forward stale, already-landed history.
