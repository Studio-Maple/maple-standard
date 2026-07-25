---
description: "[STUB] Loop-pack orchestrator: rotates sweep-errors/burn-backlog/sweep-quality/detect-drift under /loop"
---

# /dev-burner — Loop-pack orchestrator

**Status: stub.** This command is a placeholder — its full logic is written
after the loop-pack spec is approved. Do not implement ad-hoc orchestration
here; if invoked before the spec lands, report that it's unimplemented and
point at `docs/loop-pack.md`.

## Purpose

The standing-session entry point for the loop pack. Meant to be run under
`/loop` (e.g. `/loop 15m /dev-burner`) so it cycles indefinitely: each
cycle, pick the next loop from `/sweep-errors`, `/burn-backlog`,
`/sweep-quality`, `/detect-drift`, run it under its own budget, then move
to the next.

**Isolation is non-negotiable:** `/dev-burner` always works inside its own
worktree on a dedicated branch (`loop.worktreeBranch`, default
`"dev-burner"`) — the same worktree machinery as `/wt-start`, just a
long-lived branch instead of an ephemeral `agent/<slug>` one. It **never
merges** that branch into the target branch itself; landing (if any)
happens the normal way, reviewed like any other change — `/dev-burner`'s job
is to produce commits on `dev-burner`, not to self-integrate.

## Config this command will read (`maple.config.json`)

| Key | Default | Notes |
|---|---|---|
| `loop.worktreeBranch` | `"dev-burner"` | the standing branch this orchestrator works on; never auto-merged |
| `loop.devBurner.loops` | `["sweep-errors", "burn-backlog", "sweep-quality", "detect-drift"]` | ordered rotation |
| `loop.devBurner.selection` | `"round-robin"` | `"round-robin"` \| `"priority"` (future: skip a loop with nothing to do) |
| `loop.budgets.<loopName>.*` | see each loop's own command file | per-loop budgets are enforced by that loop, not re-specified here |

## Budget enforcement (to be implemented)

Per-cycle: run exactly one loop, respecting that loop's own
`loop.budgets.<loopName>` ceiling. Across cycles: this command has no
global ceiling of its own — the standing `/loop` interval controls overall
cadence; the human stops it via the normal `/loop` stop mechanism, not a
budget baked in here.

## SPEC: see docs/loop-pack.md

The exact rotation/selection algorithm, how a cycle reports back to the
standing session (so a human watching can tell what happened without
reading full transcripts), and what "never merges" means operationally
(does it ever open a PR? leave it purely as unlanded commits for `/wt-land`
to pick up manually?) are specified there once approved.

## Gap vs. the requested design

`docs/loop-pack.md` does not exist yet — it's the approval gate this whole
pack is waiting on. Every command in the pack is intentionally a stub until
that spec lands; building ahead of it would mean re-doing the work once the
real design is settled.
