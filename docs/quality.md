---
type: guide
title: Quality — the enforcement matrix
description: the enforcement matrix: every gate/hook, what it enforces, where it runs.
tags: [quality, ci, gates]
timestamp: 2026-07-25
audience: anyone asking "what stops bad code from landing here?"
authoritative_for: [the gate/hook/CI inventory and its philosophy]
code: [scripts/ci-local.sh, scripts/ci-local.ps1, .husky/pre-commit, .husky/pre-push, eslint.config.mjs, .dependency-cruiser.cjs, knip.jsonc, scripts/check-docs-drift.mjs, scripts/check-types-fresh.mjs]
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
