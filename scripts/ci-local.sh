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
# AFFECTED-ONLY (`gate`, i.e. pre-push): the changed paths of the push range
# (the hook's own refs, else @{upstream}, else origin/<default>) decide which
# fast-tier checks run. Every step prints "ran" or "skipped (reason)" and the
# table is repeated at the end. fast / core / full are always complete; `gate`
# is complete too when --full / CI_FULL=1 is passed, when no range resolves, or
# when a gate script / lockfile / shared config changed. A tree that already
# passed `gate` (same git TREE sha, recorded under .git/ci-gate-pass/) is not
# re-run: /wt-land runs the gate, then its push fires this hook on the same tree.
# Machine-wide gate slots cap concurrent heavy gates (MAPLE_GATE_SLOTS, default 2).
# Helpers: plugin/scripts/prepush/prepush-lib.sh.
#
# Escape hatch for a genuine no-Docker box (NOT --no-verify, which this
# template's CLAUDE.md forbids): SKIP_LIVE_GATE=1 runs the fast tier only and
# loudly records that the live gate was skipped.

set -euo pipefail

# -> repo root. One subshell, no dirname fork (forks are seconds on a loaded box).
_self="${BASH_SOURCE[0]}"
case "$_self" in */*) _self_dir="${_self%/*}" ;; *) _self_dir="." ;; esac
cd "$_self_dir/.."
TIER="${1:-gate}"
ROOT_DIR="$(pwd)"

# shellcheck source=../plugin/scripts/prepush/prepush-lib.sh
. "$ROOT_DIR/plugin/scripts/prepush/prepush-lib.sh"

for _arg in "$@"; do
  case "$_arg" in
    --full) CI_FULL=1; export CI_FULL ;;
  esac
done

# Shared inputs: a change here can alter the verdict of every check, so the
# gate runs everything. When in doubt, add the path here.
PP_FULL_RE='^scripts/(ci-local\.(sh|ps1)|lib/)|^plugin/scripts/prepush/|^\.husky/|(^|/)(package\.json|pnpm-lock\.yaml|\.npmrc)$|(^|/)tsconfig[^/]*\.json$|^(eslint\.config\.mjs|vitest\.config\.ts|next\.config\.ts|knip\.jsonc|\.dependency-cruiser\.cjs|maple\.config\.json)$|^src/test/setup\.ts$'

step() { echo ""; echo "--- $1 ---"; }
die()  { echo ""; echo "x $1" >&2; exit 1; }

# ---- helpers (affected-only in `gate`, the original commands when full) ----
# Decision paths are bash builtins only (see prepush-lib.sh): results come back
# in PP_M / PP_CACHE, never via $(...).

# lint: changed files only, eslint --cache (cache is per checkout, see lib)
affected_lint() {
  if pp_is_full; then
    pp_ran "lint" "full tier"
    pnpm run lint:ci
    return 0
  fi
  pp_list_existing '\.(ts|tsx|mts|js|jsx|mjs|cjs)$' '^(\.next|node_modules|\.worktrees|playwright-report|test-results)/'
  if [ "${#PP_M[@]}" -eq 0 ]; then pp_skip "lint" "no changed lintable files"; return 0; fi
  pp_ran "lint" "${#PP_M[@]} changed file(s), eslint --cache"
  pp_cache_dir eslint
  pnpm exec eslint --cache --cache-strategy content --cache-location "$PP_CACHE/" \
    --no-warn-ignored --max-warnings=0 "${PP_M[@]}"
}

affected_typecheck() {
  if pp_is_full; then pp_ran "typecheck" "full tier"; pnpm run typecheck; return 0; fi
  if ! pp_any '\.(ts|tsx|mts)$'; then pp_skip "typecheck" "no .ts/.tsx/.mts changed"; return 0; fi
  pp_ran "typecheck" "tsc --incremental"
  pp_cache_dir tsc
  pnpm exec tsc --noEmit --incremental --tsBuildInfoFile "$PP_CACHE/tsconfig.tsbuildinfo"
}

# unit tests: vitest related <changed src files>; a deleted source file runs everything
affected_vitest() {
  if pp_is_full; then pp_ran "vitest" "full tier"; pnpm run test; return 0; fi
  pp_list_deleted '^src/.*\.(ts|tsx)$'
  if [ "${#PP_M[@]}" -gt 0 ]; then
    pp_ran "vitest" "FULL suite: a source file was deleted/renamed"
    pnpm run test
    return 0
  fi
  pp_list_existing '^src/' '\.(md|png|svg|ico|css)$'
  if [ "${#PP_M[@]}" -eq 0 ]; then pp_skip "vitest" "no changed files under src/"; return 0; fi
  pp_ran "vitest" "vitest related (${#PP_M[@]} changed file(s))"
  pnpm exec vitest related --run --passWithNoTests "${PP_M[@]}"
}

# plugin suites: each runs when its own dir changed; the shared files below
# (docs/lib is imported by loops+jev, hooks by predeploy, ...) run all four.
plugin_suite() {
  local name="$1" own="^plugin/scripts/$1/" shared='^plugin/(scripts/docs/|scripts/[^/]+$|hooks/|schema/)'
  if pp_is_full; then
    pp_ran "plugin-$name" "full tier"
  elif pp_any "$own" || pp_any "$shared"; then
    pp_ran "plugin-$name" "plugin sources changed"
  else
    pp_skip "plugin-$name" "plugin/scripts/$name/ and shared plugin files untouched"
    return 0
  fi
  pnpm run "test:plugin-$name"
}

run_fast() {
  step "fast 1/7: lint (eslint --max-warnings=0, incl. eslint-plugin-security)"
  affected_lint

  step "fast 2/7: typecheck (tsc --noEmit)"
  affected_typecheck

  step "fast 3/7: knip (dead code — fails on regressions)"
  if pp_want_graph knip '^(src|scripts)/.*\.(ts|tsx|js|mjs|cjs)$'; then
    pnpm run knip
  fi

  step "fast 4/7: dependency-cruiser (module boundaries)"
  if pp_want_graph depcruise '^src/.*\.(ts|tsx)$'; then
    pnpm run depcruise || echo "(depcruise: advisory findings — not blocking unless an 'error' rule fired)"
  fi

  step "fast 5/7: unit + component tests (vitest)"
  affected_vitest

  step "fast 6/7: plugin tests (loops — m11; agent-wt junction safety)"
  plugin_suite loops
  plugin_suite agent-wt
  plugin_suite jev
  plugin_suite predeploy
  # The affected-only selection + pass stamp + gate slots, proven fail-closed.
  if pp_want plugin-prepush '^plugin/scripts/prepush/'; then
    pnpm run test:plugin-prepush
  fi

  step "fast 7/7: build (next build) + docs-drift"
  if pp_want build '^(src|public)/' '\.(test|spec)\.(ts|tsx)$|^src/test/'; then
    pnpm run build
  fi
  # docs/ edits, the drift checker itself, or any deleted/renamed path (a
  # `Code:` anchor may point at it) can change the verdict.
  pp_list_deleted '.'
  if pp_is_full || pp_any '^(docs/|plugin/scripts/docs/|scripts/check-docs-drift\.mjs$)' || [ "${#PP_M[@]}" -gt 0 ]; then
    pp_ran "docs-drift" "docs/, checker, or a deleted path changed"
    node scripts/check-docs-drift.mjs
  else
    pp_skip "docs-drift" "docs/ and the checker untouched, nothing deleted"
  fi
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

# Resolve the push range. Only `gate` is ever affected-only; every other tier
# is forced complete. When invoked from .husky/pre-push (CI_PREPUSH=1) git feeds
# the pushed refs on stdin: consume them, then detach stdin so no child can hang.
pp_prepare() {
  local refs=""
  if [ "${CI_PREPUSH:-0}" = "1" ] && [ ! -t 0 ]; then
    local line
    while IFS= read -r line || [ -n "$line" ]; do refs="$refs$line"$'\n'; done
    exec </dev/null
  fi
  case "$1" in gate) ;; *) PP_FORCE_FULL=1 ;; esac
  pp_init "$ROOT_DIR" "$refs"
}
trap pp_cleanup EXIT
pp_prepare "$TIER"

# `gate` only: a tree that already passed the gate is not re-run.
if [ "$TIER" = "gate" ]; then
  pp_lock gate || exit 1
  if pp_stamp_covers gate; then
    echo ""; echo "gate passed - tree ${PP_TREE:0:10} already passed the gate (stamp), nothing re-run."
    exit 0
  fi
fi

if [ "${SKIP_LIVE_GATE:-}" = "1" ]; then
  echo "!! SKIP_LIVE_GATE=1 - running fast tier ONLY. The live gate (RLS + E2E) was SKIPPED."
  run_fast
  pp_summary
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
    # The live tier (Supabase RLS + @smoke E2E) exercises only the template
    # app. A push that touches none of its paths (plugin/, docs/, scripts/
    # outside the app...) cannot change what it tests, so it is not run —
    # an affected-only decision, not a skip: any app path in the range runs it.
    # Same decision as before, now over the push range's changed set: live runs
    # when a template-app path changed, or when --full / no resolvable range.
    if [ "${CI_FULL:-0}" != "1" ] && [ -n "${PP_BASE:-}" ] && ! pp_any '^(src/|supabase/|e2e/|public/|package\.json$|pnpm-lock\.yaml$|next\.config\.ts$|tsconfig\.json$|vitest\.config\.ts$|scripts/check-types-fresh\.mjs$)'; then
      pp_skip "live (RLS + @smoke)" "no template-app paths changed in $PP_BASE..HEAD"
      pp_summary
      pp_stamp_write gate
      echo ""; echo "gate passed - no template-app paths changed since $PP_BASE, live tier not affected."
      exit 0
    fi
    check_types_fresh
    pp_ran "live (RLS + @smoke)" "template-app paths changed (or full)"
    run_live "--grep @smoke --project=desktop" "@smoke (desktop)"
    pp_summary
    pp_stamp_write gate
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
