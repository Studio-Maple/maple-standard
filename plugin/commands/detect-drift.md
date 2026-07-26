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

Canonical keys per `docs/standard-architecture.md` (reconciled #T11):

| Key | Default | Notes |
|---|---|---|
| `docs.gaps` | `"docs/gaps.md"` | where detected drift gets logged for owner review |
| `loops.budgetPerCycle.turns` | `40` | shared turn ceiling per loop cycle |
| `loops.budgetPerCycle.minutes` | `20` | shared wall-clock ceiling per loop cycle |
| `repo.standingLoopBranch` | `"dev-burner"` | runs in this isolated worktree branch, never merges |

The docs half of drift detection reuses the plugin's own bundled
`plugin/scripts/docs/check-docs-drift.mjs` (#T13) directly — no separate
`docs.driftScript` config key.

Malformed config? Run
`node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs"`.

## Budget enforcement (to be implemented)

Track items investigated and elapsed time against the budgets above; stop
and report partial progress when either ceiling is hit.

## SPEC: see docs/loop-pack.md

The concrete drift checks (config-key-to-path validation, hook fail-open
detection, stale marketplace/plugin version checks) and the exact
gaps.md-entry format are specified there once approved.
