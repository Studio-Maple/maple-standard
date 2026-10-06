#!/usr/bin/env bash
# docs: docs/quality.md (D066 tier matrix)
#
# THE gate runner (D066: one runner - scripts/ci-local.ps1 is a shim that execs this file under
# Git Bash). Adapted for Next.js + Vercel + Supabase (`next build && next start` +
# Playwright's own managed webServer on a gate-only port).
#
# Three tiers:
#   fast   - lint, typecheck, dead-code, arch, unit + component tests, plugin UNIT suites, build,
#            docs-drift, dep-freshness. Complete (never affected-only). No Docker, no network
#            beyond the registry. The inner-loop floor.
#   gate   - the SAME checks, affected-only (the pushed range decides what runs). **What
#            .husky/pre-push and /wt-land run.** No Docker, no live tier, no plugin integration
#            suites: a landing is light (target < 3 min typical). A docs-sync WARNING is printed
#            in the summary (non-blocking).
#   heavy  - the expensive half, batched: fast (complete) + plugin INTEGRATION suites + live RLS +
#            all desktop E2E on a gate-only port (stack started on demand, stopped afterwards if we
#            started it) + types-freshness + Jev audit + dep-freshness since the last heavy pass +
#            audit. A green run writes <git-common-dir>/maple/heavy-pass/<sha>.json and pays gate
#            debt; production promotion (predeploy verify) requires that stamp for HEAD.
#            Scheduled daily by plugin/scripts/gate/heavy-run.mjs, or run by hand: pnpm ci:heavy.
#
# Usage (from repo root):
#   bash scripts/ci-local.sh [fast|gate|heavy]   (default: gate)      [--full]  force gate to be complete
#
# AFFECTED-ONLY (`gate`, i.e. pre-push): the changed paths of the push range (the hook's own refs, else
# @{upstream}, else origin/<default>) decide which checks run. Every step prints "ran" or "skipped
# (reason)" and the table (with timings) is repeated at the end. `gate` is complete when --full /
# CI_FULL=1 is passed, when no range resolves, or when a gate script / lockfile / shared config
# changed. A tree that already passed `gate` (same git TREE sha, .git/ci-gate-pass/) is not re-run.
# Machine-wide gate slots cap concurrent heavy steps (MAPLE_GATE_SLOTS, default 2).
# Helpers: plugin/scripts/prepush/prepush-lib.sh.
#
# Skips (NOT --no-verify, which is forbidden): MAPLE_GATE_SKIP=<reason> where reason is one of
#   docker-unavailable   (step: live - verified: `docker info` fails or the stack's ports cannot be bound)
#   registry-unreachable (step: dep-freshness - verified: the registry does not answer)
# An unlisted reason fails; a reason that is not true on this machine is refused (the step runs). Every
# honoured skip appends {sha, branch, step, reason, at, who} to <git-common-dir>/maple/gate-debt.jsonl and
# a heavy run that skipped anything writes no stamp. A green full heavy run on a commit containing the
# skipped commits pays the debt. SKIP_LIVE_GATE=1 is a deprecated alias for docker-unavailable.

set -euo pipefail

# -> repo root. One subshell, no dirname fork (forks are seconds on a loaded box).
_self="${BASH_SOURCE[0]}"
_self="${_self//\\//}"   # a Windows caller (the .ps1 shim, run-gate.mjs) may pass backslashes
case "$_self" in */*) _self_dir="${_self%/*}" ;; *) _self_dir="." ;; esac
cd "$_self_dir/.."
TIER="${1:-gate}"
ROOT_DIR="$(pwd)"

# A git hook exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE ... to everything it
# runs; left in place, every `git init` / `git config` / `git push` a self-test makes
# in a temp repo hits the REAL repository (it corrupted core.bare/user/branches).
for _v in $(git rev-parse --local-env-vars 2>/dev/null); do unset "$_v"; done

# shellcheck source=plugin/scripts/prepush/prepush-lib.sh
. "$ROOT_DIR/plugin/scripts/prepush/prepush-lib.sh"

for _arg in "$@"; do
  case "$_arg" in
    --full) CI_FULL=1; export CI_FULL ;;
  esac
done

# The plugin's gate scripts: in this repo ./plugin, in a consumer the installed plugin.
PLUGIN_DIR="${MAPLE_PLUGIN_DIR:-}"
if [ -z "$PLUGIN_DIR" ]; then
  if [ -d "$ROOT_DIR/plugin/scripts/gate" ]; then PLUGIN_DIR="$ROOT_DIR/plugin"
  elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then PLUGIN_DIR="$CLAUDE_PLUGIN_ROOT"
  fi
fi
GATE_CLI="$PLUGIN_DIR/scripts/gate/gate-cli.mjs"

# Shared inputs: a change here can alter the verdict of EVERY check, so the gate runs everything.
# Configs that affect ONE tool (knip, depcruise, gitleaks) are not here: they escalate only their own step.
export PP_FULL_RE='^scripts/(ci-local\.(sh|ps1)|lib/)|^plugin/scripts/prepush/|^\.husky/|(^|/)(package\.json|pnpm-lock\.yaml|\.npmrc)$|(^|/)tsconfig[^/]*\.json$|^(eslint\.config\.mjs|vitest\.config\.ts|next\.config\.ts|maple\.config\.json)$|^src/test/setup\.ts$'

# Machine-wide gate slots (MAPLE_GATE_SLOTS) cap concurrent HEAVY work. D066: a landing must not queue behind other
# repos' builds before it has done any work (75-153 s slot waits were measured before the first lint), so only the
# genuinely heavy steps take a slot: build, the integration suites, the live tier, the audits. Everything else is light.
export PP_LIGHT_RE='^(lint|typecheck|knip|depcruise|vitest|plugin-(loops|agent-wt|jev|predeploy|deps|gate|prepush)|docs-drift|dep-freshness( \(heavy\))?|edge-typecheck|gitleaks|user-data-size|migration-duplicates|supply-chain|workflow-triggers|orphan-tables)$'

step() { echo ""; echo "--- $1 ---"; }
die()  { echo ""; echo "x $1" >&2; exit 1; }

PP_SKIPS=0   # honoured MAPLE_GATE_SKIPs in this run (a heavy run with any never stamps)

# gate_skip <step> -> 0 when MAPLE_GATE_SKIP applies to <step>, is TRUE here and was recorded as debt
# (the caller then skips the step); 1 when the step must run (no skip requested, not applicable, or
# the claimed reason is false on this machine).
gate_skip() {
  [ -n "${MAPLE_GATE_SKIP:-}" ] || [ "${SKIP_LIVE_GATE:-}" = "1" ] || return 1
  [ -f "$GATE_CLI" ] || die "MAPLE_GATE_SKIP is set but $GATE_CLI is missing - cannot record gate debt, so nothing is skipped"
  local rc=0 refargs=()
  if [ -n "${GATE_DEBT_REF:-}" ]; then refargs=(--ref "$GATE_DEBT_REF"); fi
  node "$GATE_CLI" skip --step "$1" "${refargs[@]}" || rc=$?
  case "$rc" in
    0) PP_SKIPS=$((PP_SKIPS + 1)); pp_skip "$1" "MAPLE_GATE_SKIP honoured - recorded as gate debt"; return 0 ;;
    3) return 1 ;;                                    # reason valid but covers another step
    1) echo "  (skip refused - the claimed reason is false here; running $1)"; return 1 ;;
    *) die "MAPLE_GATE_SKIP refused (see above)" ;;
  esac
}

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

# plugin UNIT suites (the integration set runs in `heavy`): each runs when its own dir changed; the
# shared files below (docs/lib is imported by loops+jev, hooks by predeploy, ...) run all of them.
plugin_suite() {
  local name="$1" own="^plugin/scripts/$1/" shared='^plugin/(scripts/docs/|scripts/[^/]+$|hooks/|schema/)'
  if pp_is_full; then
    pp_ran "plugin-$name" "full tier (unit set)"
  elif pp_any "$own" || pp_any "$shared"; then
    pp_ran "plugin-$name" "plugin sources changed (unit set)"
  else
    pp_skip "plugin-$name" "plugin/scripts/$name/ and shared plugin files untouched"
    return 0
  fi
  pnpm run "test:plugin-$name"
}

# a check whose OWN config escalates just that check (knip.jsonc, .dependency-cruiser.cjs): not a global
# PP_FULL_RE entry, so editing one tool's config no longer re-runs the world.
graph_step() { # graph_step <id> <graph-path-ere> <own-config-ere>
  if ! pp_is_full && pp_any "$3"; then pp_ran "$1" "its own config changed"; return 0; fi
  pp_want_graph "$1" "$2"
}

run_fast() {
  step "fast 1/7: lint (eslint --max-warnings=0, incl. eslint-plugin-security)"
  affected_lint

  step "fast 2/7: typecheck (tsc --noEmit)"
  affected_typecheck

  step "fast 3/7: knip (dead code - fails on regressions)"
  if graph_step knip '^(src|scripts)/.*\.(ts|tsx|js|mjs|cjs)$' '^knip\.jsonc?$|^scripts/run-knip\.mjs$'; then
    pnpm run knip
  fi

  step "fast 4/7: dependency-cruiser (module boundaries)"
  if graph_step depcruise '^src/.*\.(ts|tsx)$' '^\.dependency-cruiser\.cjs$'; then
    pnpm run depcruise || echo "(depcruise: advisory findings - not blocking unless an 'error' rule fired)"
  fi

  step "fast 5/7: unit + component tests (vitest: node + jsdom projects)"
  affected_vitest

  step "fast 6/7: plugin unit tests (loops, agent-wt, jev, predeploy, deps, gate; prepush toolkit)"
  plugin_suite loops
  plugin_suite agent-wt
  plugin_suite jev
  plugin_suite predeploy
  plugin_suite deps
  plugin_suite hooks
  plugin_suite gate
  # The affected-only selection + pass stamp + gate slots, proven fail-closed.
  if pp_want plugin-prepush '^(plugin/scripts/prepush/|scripts/install-hooks\.mjs$|\.husky/)'; then
    pnpm run test:plugin-prepush
  fi

  step "fast 7/7: build (next build) + docs-drift + dep-freshness"
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
  # D064: every dependency added/changed vs the target branch must be at the latest major (registry lookup;
  # diff-scoped, so it only ever touches the network when a package.json changed).
  if pp_is_full || pp_any '(^|/)package\.json$|^maple\.config\.json$|^docs/decisions\.md$|^plugin/scripts/deps/'; then
    if ! gate_skip dep-freshness; then
      pp_ran "dep-freshness" "package.json / config / ledger changed"
      node scripts/check-dep-freshness.mjs
    fi
  else
    pp_skip "dep-freshness" "no package.json, config or decision ledger change"
  fi
  if pp_want hook-wiring '^(\.claude/|plugin/hooks/|plugin/scripts/hooks/)'; then node plugin/scripts/hooks/check-hook-wiring.mjs; fi
}

# ---- heavy-only pieces ------------------------------------------------------
STACK_STARTED=0
stack_up() {
  # pnpm exec - a bare `supabase` resolves to whatever global CLI is on
  # PATH, which can be older than the project's and fail parsing config.toml.
  pnpm exec supabase status -o env >/dev/null 2>&1
}

# D052: containers started by `supabase start` carry restart:unless-stopped; strip it so Docker Desktop
# never resurrects the stack at boot.
strip_restart_policies() {
  local pid line ids=()
  pid="$(sed -n 's/^project_id *= *"\([^"]*\)".*/\1/p' supabase/config.toml | head -1)"
  [ -n "$pid" ] || return 0
  while IFS= read -r line; do
    if [ -n "$line" ]; then ids+=("$line"); fi
  done < <(docker ps -aq --filter "label=com.supabase.cli.project=$pid" 2>/dev/null || true)
  if [ "${#ids[@]}" -gt 0 ]; then docker update --restart=no "${ids[@]}" >/dev/null 2>&1 || true; fi
}

# Local Docker stacks stay on demand (D052): start only when not already up, stop afterwards only what we started.
ensure_stack() {
  if stack_up; then echo "(local Supabase stack already running - using it)"; return 0; fi
  echo "starting the local Supabase stack (on demand; stopped again when this run ends)..."
  STACK_STARTED=1
  # stdout carries the local keys and URLs (status -o env); a gate log must not. Errors stay on stderr.
  pnpm exec supabase start >/dev/null || return 1
  strip_restart_policies
  # A cold start from an existing volume ("Starting database from backup") can report up before the
  # database accepts the reset; on a loaded box the first reset then dies with DbSetupError. Wait for
  # status, then allow exactly one more reset - this is stack setup, not a test, so it is not a retry
  # of anything the gate judges.
  if ! pnpm exec supabase db reset >/dev/null; then
    echo "db reset failed right after start - waiting for the stack, then one more attempt..."
    local waited=0
    until stack_up || [ "$waited" -ge 60 ]; do pp_sleep 5; waited=$(( waited + 5 )); done
    pnpm exec supabase db reset >/dev/null || return 1
  fi
}

stop_stack_if_ours() {
  if [ "$STACK_STARTED" -eq 1 ]; then
    STACK_STARTED=0
    echo "stopping the Supabase stack this run started..."
    pnpm exec supabase stop >/dev/null 2>&1 || true
  fi
}

check_types_fresh() {
  step "heavy: types-freshness (src/types/database.types.ts vs local schema)"
  MAPLE_REQUIRE_STACK=1 node scripts/check-types-fresh.mjs
}

# Live tier: RLS suite + all desktop E2E on a gate-only port (playwright.config.ts: E2E_PORT, default 3100,
# never reusing a server; the build from fast 7/7 is reused via E2E_SKIP_BUILD=1).
run_live() {
  ensure_stack || die "could not start the local Supabase stack (Docker down, or its ports cannot be bound?). On a box that genuinely cannot run it: MAPLE_GATE_SKIP=docker-unavailable (recorded as gate debt)"
  check_types_fresh

  step "heavy: Supabase RLS + trigger suite"
  pnpm run test:supabase

  step "heavy: Playwright - all desktop specs (port ${E2E_PORT:-3100})"
  E2E_SKIP_BUILD=1 pnpm exec playwright test --config e2e/playwright.config.ts --project=desktop
}

# Edge Functions are Deno: typecheck them when the toolchain is present (silent skip otherwise).
edge_typecheck() {
  local f d n=0
  command -v deno >/dev/null 2>&1 || { pp_skip "edge-typecheck" "deno not installed"; return 0; }
  [ -d supabase/functions ] || { pp_skip "edge-typecheck" "no supabase/functions"; return 0; }
  pp_ran "edge-typecheck" "deno check"
  while IFS= read -r f; do
    d="${f%/*}"; n=$((n + 1))
    if [ -f "$d/deno.json" ]; then deno check --config "$d/deno.json" "$f"; else deno check "$f"; fi
  done < <(find supabase/functions -name '*.ts' -not -path '*/node_modules/*' -not -name '*.test.ts')
  echo "  $n edge function file(s) checked"
}

# Per-function Jev audit of everything changed since the last green heavy run (moved out of /wt-land, D066
# amending D059). Opt-in via maple.config.json quality.jevAudit.enabled.
run_jev_audit() {
  local enabled audit base
  enabled="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync("maple.config.json","utf8"))?.quality?.jevAudit?.enabled===true))}catch{process.stdout.write("false")}')"
  if [ "$enabled" != "true" ]; then pp_skip "jev-audit" "quality.jevAudit.enabled is not true"; return 0; fi
  audit="$PLUGIN_DIR/scripts/jev/audit/run.mjs"
  [ -f "$audit" ] || die "quality.jevAudit is enabled but $audit is missing"
  base="$(node "$GATE_CLI" base 2>/dev/null || true)"
  if [ -z "$base" ]; then base="$(git rev-parse -q --verify "HEAD~${MAPLE_HEAVY_AUDIT_LOOKBACK:-25}" 2>/dev/null || git rev-list --max-parents=0 HEAD | tail -1)"; fi
  pp_ran "jev-audit" "changed functions since ${base:0:10}"
  node "$audit" --gate --base "$base"
}

run_integration() {
  step "heavy: plugin integration suites (Docker/network/real-git; the unit set ran in fast)"
  if [ ! -d "$ROOT_DIR/plugin/scripts/gate" ]; then pp_skip "plugin-integration" "no plugin sources in this checkout"; return 0; fi
  pp_ran "plugin-integration" "every suite's integration set"
  pnpm run test:plugin-integration
}

run_audit() {
  step "heavy: pnpm audit (SCA - free, no token; Snyk deep-scan runs in CI)"
  pnpm audit --audit-level=high || echo "(pnpm audit: high/critical advisories - triage)"
}

run_heavy() {
  run_fast
  run_integration

  step "heavy: dependency freshness since the last green heavy run (the landings' diff-scoped checks are paid here)"
  local base baseargs=()
  base="$(node "$GATE_CLI" base 2>/dev/null || true)"
  if [ -n "$base" ]; then baseargs=(--base "$base"); fi
  if ! gate_skip dep-freshness; then
    pp_ran "dep-freshness (heavy)" "all dependency changes since ${base:-<merge-base>}"
    node scripts/check-dep-freshness.mjs "${baseargs[@]}"
  fi

  if ! gate_skip live; then
    pp_ran "live (RLS + E2E)" "heavy tier: Docker stack on demand"
    run_live
  fi
  edge_typecheck

  step "heavy: Jev quality audit (changed functions since the last green heavy run)"
  run_jev_audit
  run_audit
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
  case "$1" in gate) ;; *) export PP_FORCE_FULL=1 ;; esac
  pp_init "$ROOT_DIR" "$refs"
}
# On exit: a gate that passed re-checks that the target branch did not move
# during it (another machine); any failure frees the landing lock at once (the
# push will not happen; on success the lock stays until the `git push` that fired
# this hook exits, then its dead pid releases it). A stack this run started is stopped.
ci_cleanup() {
  local rc=$?
  stop_stack_if_ours
  if [ "$rc" -eq 0 ] && [ "$TIER" = "gate" ]; then pp_land_hook_end || rc=1; fi
  if [ "$rc" -ne 0 ]; then pp_land_release_all; fi
  pp_cleanup
  exit "$rc"
}
trap ci_cleanup EXIT

case "$TIER" in fast|gate|heavy) ;; *) die "Unknown tier '$TIER'. Use: fast | gate | heavy" ;; esac

# An unlisted MAPLE_GATE_SKIP fails before any work.
if [ -n "${MAPLE_GATE_SKIP:-}" ] || [ "${SKIP_LIVE_GATE:-}" = "1" ]; then
  [ -f "$GATE_CLI" ] || die "MAPLE_GATE_SKIP is set but the plugin's gate scripts are not found (set MAPLE_PLUGIN_DIR)"
  node "$GATE_CLI" validate || die "unlisted MAPLE_GATE_SKIP reason"
  if [ "${SKIP_LIVE_GATE:-}" = "1" ] && [ -z "${MAPLE_GATE_SKIP:-}" ]; then
    echo "!! SKIP_LIVE_GATE=1 is deprecated - treated as MAPLE_GATE_SKIP=docker-unavailable (honoured only if docker really is unavailable)"
  fi
fi

pp_prepare "$TIER"

# `gate` only: a tree that already passed the gate is not re-run.
if [ "$TIER" = "gate" ]; then
  # The gate is only a gate if git runs it: refuse from a clone whose hooks are
  # not fail-closed (a worktree without husky's generated .husky/_ used to push
  # with NO gate). Skipped in CI runners and outside a git checkout.
  if [ -z "${CI:-}" ] && [ -e "$ROOT_DIR/.git" ]; then
    # repair first (idempotent: install/husky reset the path), then verify
    node "$ROOT_DIR/scripts/install-hooks.mjs" --quiet && node "$ROOT_DIR/scripts/install-hooks.mjs" --check --quiet || exit 1
  fi
  # Concurrency-proof landing (pre-push hook mode only): refuse AT ONCE when the
  # target branch moved past the pushed commit, then wait for the per-branch
  # landing lock, then check again (and once more when the gate has passed).
  pp_land_hook_begin "${CI_PREPUSH_REMOTE:-origin}" || exit 1
  pp_lock gate || exit 1
  if pp_stamp_covers gate; then
    echo ""; echo "gate passed - tree ${PP_TREE:0:10} already passed the gate (stamp), nothing re-run."
    exit 0
  fi
fi
if [ "$TIER" = "heavy" ]; then pp_lock heavy || exit 1; fi

case "$TIER" in
  fast)
    run_fast
    pp_summary
    echo ""; echo "fast tier passed (complete, no Docker - 'gate' is what pushes run; 'heavy' before promotion)."
    ;;
  gate)
    run_fast
    # Non-blocking: code changed under a doc's declared ownership while the doc / CHANGELOG stayed untouched.
    docs_warn=""
    if [ -n "${PP_BASE:-}" ] && [ -f "$PLUGIN_DIR/scripts/docs/check-docs-touched.mjs" ]; then
      docs_warn="$(node "$PLUGIN_DIR/scripts/docs/check-docs-touched.mjs" --base "$PP_BASE" 2>&1 || true)"
    fi
    pp_summary
    if [ -n "$docs_warn" ]; then echo ""; printf '%s\n' "$docs_warn"; fi
    pp_stamp_write gate
    echo ""; echo "gate passed - safe to push (live RLS/E2E is the heavy tier: pnpm ci:heavy)."
    ;;
  heavy)
    run_heavy
    pp_summary
    echo ""
    if [ "$PP_SKIPS" -gt 0 ]; then
      echo "heavy tier passed with $PP_SKIPS SKIPPED step(s): no heavy stamp, gate debt NOT paid (production stays blocked)."
    else
      node "$GATE_CLI" stamp --skipped 0
      echo "heavy passed - fast + integration + live RLS/E2E + audits green."
    fi
    ;;
esac
