#!/usr/bin/env bash
# docs: docs/quality/ci.md (fill in as you adapt this template)
#
# Local CI gate — the tiered enforcement mirrored in .github/workflows/. Adapted
# for Next.js + Vercel + Supabase (no Cloudflare
# Workers/wrangler port-isolation dance — `next build && next start` +
# Playwright's own managed webServer replace it).
#
# Four tiers (escalating cadence — inner loop -> nightly):
#   fast  — lint, typecheck, dead-code, arch, unit tests, build. No Docker.
#           The floor; not a release signal by itself.
#   gate  — fast + Supabase RLS/trigger suite + @smoke E2E. **What
#           .husky/pre-push runs** — every push. You cannot push red. (default)
#   core  — fast + RLS + ALL E2E specs (desktop only). Pre-merge confidence.
#   full  — fast + RLS + ALL E2E specs + npm audit. Nightly, unattended.
#
# Usage (from repo root):
#   bash scripts/ci-local.sh [fast|gate|core|full]   (default: gate)
#
# The RLS/E2E ("live") tiers need the local Supabase stack up (Docker):
#   pnpm supabase:start && pnpm supabase:reset
#
# Escape hatch for a genuine no-Docker box (NOT --no-verify, which this
# template's CLAUDE.md forbids): SKIP_LIVE_GATE=1 runs the fast tier only and
# loudly records that the live gate was skipped.

set -euo pipefail

cd "$(dirname "$0")/.."   # -> repo root
TIER="${1:-gate}"

step() { echo ""; echo "--- $1 ---"; }
die()  { echo ""; echo "x $1" >&2; exit 1; }

run_fast() {
  step "fast 1/6: lint (eslint --max-warnings=0, incl. eslint-plugin-security)"
  pnpm run lint:ci

  step "fast 2/6: typecheck (tsc --noEmit)"
  pnpm run typecheck

  step "fast 3/6: knip (dead code — fails on regressions)"
  pnpm run knip

  step "fast 4/6: dependency-cruiser (module boundaries)"
  pnpm run depcruise || echo "(depcruise: advisory findings — not blocking unless an 'error' rule fired)"

  step "fast 5/6: unit + component tests (vitest)"
  pnpm run test

  step "fast 6/6: build (next build) + docs-drift"
  pnpm run build
  node scripts/check-docs-drift.mjs
}

stack_up() {
  # pnpm exec — a bare `supabase` resolves to whatever global CLI is on
  # PATH, which can be older than the project's and fail parsing config.toml.
  pnpm exec supabase status -o env >/dev/null 2>&1
}

require_stack() {
  if ! stack_up; then
    die "Local Supabase not reachable.
   Bring it up in another shell:
     pnpm supabase:start && pnpm supabase:reset
   (needs Docker Desktop). To push from a no-Docker box anyway:
     SKIP_LIVE_GATE=1 git push   # runs fast tier only, records the skip"
  fi
}

check_types_fresh() {
  step "types-freshness: src/types/database.types.ts vs local schema"
  node scripts/check-types-fresh.mjs
}

# $1 = playwright arg string (word-split deliberately — literal values only),
# $2 = human label. Playwright's own webServer (e2e/playwright.config.ts)
# builds + boots the app; no separate isolated-build step needed.
run_live() {
  require_stack

  step "live: Supabase RLS + trigger suite"
  pnpm run test:supabase

  step "live: Playwright — $2"
  # shellcheck disable=SC2086  # deliberate word-split of the literal arg set
  pnpm exec playwright test --config e2e/playwright.config.ts $1
}

run_audit() {
  step "full: pnpm audit (SCA — free, no token; Snyk deep-scan runs in CI)"
  pnpm audit --audit-level=high || echo "(pnpm audit: high/critical advisories — triage)"
}

if [ "${SKIP_LIVE_GATE:-}" = "1" ]; then
  echo "!! SKIP_LIVE_GATE=1 - running fast tier ONLY. The live gate (RLS + E2E) was SKIPPED."
  run_fast
  echo ""
  echo "fast tier passed. LIVE GATE SKIPPED - re-run with the local Supabase stack up."
  exit 0
fi

case "$TIER" in
  fast)
    run_fast
    echo ""; echo "fast tier passed (no live checks - use 'gate' before push)."
    ;;
  gate)
    run_fast
    check_types_fresh
    run_live "--grep @smoke --project=desktop" "@smoke (desktop)"
    echo ""; echo "gate passed - safe to push."
    ;;
  core)
    run_fast
    check_types_fresh
    run_live "--project=desktop" "all specs (desktop)"
    echo ""; echo "core passed - fast + RLS + full desktop E2E green (pre-merge)."
    ;;
  full)
    run_fast
    check_types_fresh
    run_live "" "all specs, all projects"
    run_audit
    echo ""; echo "full passed - fast + RLS + full E2E + audit."
    ;;
  *)
    die "Unknown tier '$TIER'. Use: fast | gate | core | full"
    ;;
esac
