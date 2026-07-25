---
description: "[STUB] Loop-pack: find (not fix) docs/config/infra drift, budget-bounded"
---

# /detect-drift — Loop-pack stub

**Status: stub.** This command is a placeholder in the `dev-burner` loop
pack — its full logic is written after the loop-pack spec is approved. Do
not implement ad-hoc logic here; if invoked before the spec lands, report
that it's unimplemented and point at `docs/loop-pack.md`.

## Purpose

One cycle of *detecting* drift this loop pack's other members don't already
cover — e.g. `maple.config.json` keys pointing at paths that no longer
exist, hook scripts silently no-op'ing because a config key is missing,
infra/CI config drifting from what the docs claim — and writing it up as
gaps/tasks rather than fixing it live. Detection only; fixing is
`/burn-backlog`'s or `/sync-docs`'s job.

## Config this command will read (`maple.config.json`)

| Key | Default | Notes |
|---|---|---|
| `docs.gapsFile` | `"docs/gaps.md"` | where detected drift gets logged for owner review |
| `docs.driftScript` | `"scripts/check-docs-drift.mjs"` | reused for the docs half of drift detection |
| `loop.budgets.detectDrift.maxIterations` | `5` | max drift items investigated per invocation |
| `loop.budgets.detectDrift.maxMinutes` | `15` | wall-clock ceiling per invocation |
| `loop.worktreeBranch` | `"dev-burner"` | runs in this isolated worktree branch, never merges |

## Budget enforcement (to be implemented)

Track items investigated and elapsed time against the budgets above; stop
and report partial progress when either ceiling is hit.

## SPEC: see docs/loop-pack.md

The concrete drift checks (config-key-to-path validation, hook fail-open
detection, stale marketplace/plugin version checks) and the exact
gaps.md-entry format are specified there once approved.
