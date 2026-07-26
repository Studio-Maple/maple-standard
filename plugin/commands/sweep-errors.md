---
description: "[STUB] Loop-pack: sweep tracked errors down to zero, budget-bounded"
---

# /sweep-errors — Loop-pack stub

**Status: stub.** This command is a placeholder in the `dev-burner` loop
pack — its full logic is written after the loop-pack spec is approved. Do
not implement ad-hoc logic here; if invoked before the spec lands, report
that it's unimplemented and point at `docs/loop-pack.md`.

## Purpose

One cycle of `/heal`-style error triage, scoped to run unattended and
budget-bounded (unlike `/heal`, which is interactive and open-ended). Meant
to be invoked by `/dev-burner` as one of the loops it rotates through, or run
standalone via `/loop`.

## Config this command will read (`maple.config.json`)

Canonical keys per `docs/standard-architecture.md` (reconciled #T11):

| Key | Default | Notes |
|---|---|---|
| `errorTracker.*` | — | same tracker config as `/heal` (provider/endpoint/readTokenRef/writeTokenRef/sentryProject) |
| `loops.budgetPerCycle.turns` | `40` | shared turn ceiling per loop cycle |
| `loops.budgetPerCycle.minutes` | `20` | shared wall-clock ceiling per loop cycle |
| `repo.standingLoopBranch` | `"dev-burner"` | runs in this isolated worktree branch, never merges |

Malformed config? Run
`node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs"`.

## Budget enforcement (to be implemented)

Track iteration count and elapsed time against the budgets above; stop and
report partial progress (not an error) when either ceiling is hit. Never
silently exceed a budget.

## SPEC: see docs/loop-pack.md

Full triage logic, verification ladder reuse from `/heal`, and how partial
runs resume next cycle are specified there once approved.
