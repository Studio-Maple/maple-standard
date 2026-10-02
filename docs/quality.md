---
type: guide
title: Quality — the enforcement matrix
description: the enforcement matrix: every gate/hook, what it enforces, where it runs.
tags: [quality, ci, gates]
timestamp: 2026-07-25
audience: anyone asking "what stops bad code from landing here?"
authoritative_for: [the gate/hook/CI inventory and its philosophy]
code: [scripts/ci-local.sh, scripts/ci-local.ps1, .husky/pre-commit, .husky/pre-push, eslint.config.mjs, .dependency-cruiser.cjs, knip.jsonc, scripts/check-docs-drift.mjs, scripts/check-types-fresh.mjs, plugin/scripts/prepush/prepush-lib.sh]
---
# Quality — the enforcement matrix

**Enforce by mechanism, not by trust.** Discipline drifts; a CI check, a
hook, or a compile error doesn't. Every rule in [[../CLAUDE.md|CLAUDE.md]]
is (or becomes) one.

## Local tiers (`scripts/ci-local.sh` / `.ps1`)

| Tier | Contents | When |
|---|---|---|
| `fast` | eslint --max-warnings=0 → tsc → knip → depcruise → vitest → next build → docs-drift | inner loop |
| `gate` | fast + types-freshness + RLS suite + @smoke E2E | **pre-push (husky)** — you cannot push red |
| `core` | fast + types-freshness + RLS + all E2E (desktop) | pre-merge |
| `full` | core breadth + all E2E projects + pnpm audit | nightly |

On landing, after the tier is green, the per-function [[quality-gate|Jev quality gate]] checks every created or edited function (D059).

## Affected-only pre-push (`gate`)

`gate` does not re-run the world on every push. It resolves the push range
(the hook's own refs when `CI_PREPUSH=1`, else `@{upstream}`, else
`origin/<default>`) and runs only the checks the changed paths can affect:
changed-file eslint (`--cache`, per checkout), `tsc --incremental` for
`.ts/.tsx/.mts` changes, `vitest related`, knip/depcruise only when the
import graph may have changed (a file added/deleted or an import/export line
edited), `next build` only for `src/`/`public/`, each plugin suite when its own
directory or a shared plugin file changed, docs-drift only for `docs/`, the
checker or a deleted path. Every step prints "ran" or "skipped (reason)" and
the table is repeated at the end, so nothing is skipped silently.

- **Fails closed to the complete fast tier** when `--full` / `CI_FULL=1` is
  passed, when no range resolves, or when a gate script (`scripts/ci-local.*`,
  `plugin/scripts/prepush/`, `.husky/`), a lockfile / `package.json`, or a
  shared config (tsconfig, eslint/vitest/next config, knip, depcruise) changed.
  The live RLS/@smoke tier keeps its own app-path rule. `fast`, `core` and
  `full` are always complete.
- **Tree-bound pass stamp.** A green `gate` on a clean tracked tree records
  `.git/ci-gate-pass/gate-<tree sha>` (same stamp across worktrees). The same
  tree is not re-run, so `/wt-land` plus the push it makes run the gate once.
  It never satisfies another tree sha, a dirty tree, a larger change set, or an
  explicit `--full`.
- **Machine-wide gate slots.** Heavy steps take one of `MAPLE_GATE_SLOTS`
  (default 2, `0` disables) slots stored under `%LOCALAPPDATA%/maple-gate-slots`,
  shared by every worktree and repo. Waiting gates print "waiting for gate slot
  (k ahead)"; a dead PID frees its slot; after `MAPLE_GATE_SLOT_WAIT` seconds
  the gate runs anyway (it is a politeness limiter, never a skip). Caches and
  locks are per checkout.
- **Reusable toolkit.** `plugin/scripts/prepush/prepush-lib.sh` (tested by
  `pnpm test:plugin-prepush`) holds the range, selection, stamp, cache, lock and
  slot logic; other projects vendor it into their own `ci-local.sh`
  (EasyCaller: `scripts/lib/prepush-lib.sh`). Decisions use bash builtins only,
  because a fork costs seconds on a loaded Windows box.

Escape hatch for a no-Docker box: `SKIP_LIVE_GATE=1` (runs fast only,
loudly). `--no-verify` is forbidden — see CLAUDE.md "No bypass".

## Cloud CI (`.github/workflows/`)

| Workflow | Enforces | Cadence |
|---|---|---|
| quality.yml | lint/tsc/knip/depcruise/vitest/build/docs-drift (requirable check) | push, PR, daily |
| supabase-migrations.yml | migrations apply clean + `database.types.ts` freshness | supabase/** changes |
| codeql.yml | SAST (security-extended) | push, PR, weekly |
| snyk.yml | SAST + SCA (token-conditional, quota-aware) | daily schedule |
| gitleaks.yml | secret scanning (diff on PR, full history weekly) | PR, push, weekly |
| zap.yml | DAST baseline vs staging URL | weekly |
| drift-sentinel.yml | prod schema == migrations (`db diff --linked`) | migrations push, weekly |
| dependabot-automerge.yml | validates dep bumps; automerges safe classes | Dependabot PRs |

## Always-on hooks

Claude Code hooks (`.claude/settings.json` + `.claude/hooks/`): eslint-fix,
size-warning, build-counter, scrub-secrets, deny-credential-paths,
ask-gate, dirty-tree-guard, docs-sync-reminder, decision-reminder,
parallel-session-warn. Git hooks (`.husky/`): staged lint+tsc + migration
naming (pre-commit), the gate tier (pre-push).

Full per-gate detail: the README's "What's enforced" table.
