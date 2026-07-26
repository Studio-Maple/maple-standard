---
description: "[STUB] Loop-pack: burn down docs/tasks.md, budget-bounded"
---

# /burn-backlog — Loop-pack stub

**Status: stub.** This command is a placeholder in the `dev-burner` loop
pack — its full logic is written after the loop-pack spec is approved. Do
not implement ad-hoc logic here; if invoked before the spec lands, report
that it's unimplemented and point at `docs/loop-pack.md`.

## Purpose

One cycle of picking up open tasks (`docs.tasksFile`) and landing them,
unattended and budget-bounded. Meant to be invoked by `/dev-burner` as one
of the loops it rotates through, or run standalone via `/loop`.

## Config this command will read (`maple.config.json`)

Canonical keys per `docs/standard-architecture.md` (reconciled #T11):

| Key | Default | Notes |
|---|---|---|
| `docs.tasks` | `"docs/tasks.md"` | the backlog to burn down |
| `ci.tiers.<name>` | — | reused to verify each landed task |
| `loops.budgetPerCycle.turns` | `40` | shared turn ceiling per loop cycle (was a separate `burnBacklog`-specific budget; now shared across the loop pack) |
| `loops.budgetPerCycle.minutes` | `20` | shared wall-clock ceiling per loop cycle |
| `repo.standingLoopBranch` | `"dev-burner"` | runs in this isolated worktree branch, never merges |

Malformed config? Run
`node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs"`.

## Budget enforcement (to be implemented)

Track task count and elapsed time against the budgets above; stop and
report partial progress when either ceiling is hit. Never silently exceed a
budget. A task that turns out too large for one cycle should be split, not
force-finished over budget.

## SPEC: see docs/loop-pack.md

Full task-selection strategy (priority order, what's safe to pick up
unattended vs. what needs a human decision first), and how it interacts
with `ci.tiers` verification, are specified there once approved.
