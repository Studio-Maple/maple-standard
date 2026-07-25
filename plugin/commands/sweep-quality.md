---
description: "[STUB] Loop-pack: chip away lint/type/size/dead-code debt, budget-bounded"
---

# /sweep-quality — Loop-pack stub

**Status: stub.** This command is a placeholder in the `dev-burner` loop
pack — its full logic is written after the loop-pack spec is approved. Do
not implement ad-hoc logic here; if invoked before the spec lands, report
that it's unimplemented and point at `docs/loop-pack.md`.

## Purpose

One cycle of finding and fixing quality debt that isn't a tracked error or a
backlog task — lint warnings, oversize files, dead code/exports, type
looseness — unattended and budget-bounded.

## Config this command will read (`maple.config.json`)

| Key | Default | Notes |
|---|---|---|
| `worktree.gate.tiers.fast` | — | reused as the "did I break anything" check after each fix |
| `loop.budgets.sweepQuality.maxIterations` | `10` | max fixes per invocation |
| `loop.budgets.sweepQuality.maxMinutes` | `30` | wall-clock ceiling per invocation |
| `loop.worktreeBranch` | `"dev-burner"` | runs in this isolated worktree branch, never merges |

## Budget enforcement (to be implemented)

Track fix count and elapsed time against the budgets above; stop and report
partial progress when either ceiling is hit. Never silently exceed a
budget.

## SPEC: see docs/loop-pack.md

What counts as "safe to auto-fix" vs. "flag, don't touch" (e.g. a genuine
API redesign masquerading as a lint fix), and how findings are sourced
(re-running the fast gate vs. a dedicated linter pass), are specified there
once approved.
