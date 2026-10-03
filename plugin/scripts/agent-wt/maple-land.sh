#!/usr/bin/env bash
# maple-land [--tier <name>] [--keep] [--no-push]
#
# The semaphore. Run from INSIDE an agent worktree to integrate it back into
# the target branch. Under a single global lock it:
#
#   1. rebases the branch onto the freshest origin/<targetBranch>,
#   2. runs the configured gate command for --tier (maple.config.json
#      ci.tiers.<tier>; default tier ci.prePushTier),
#   3. pushes HEAD:<targetBranch> (a guaranteed fast-forward, because nothing
#      else could have advanced the target while we held the lock),
#   4. prunes the worktree + branch.
#
# Red gate, rebase conflict, or non-ff push -> it refuses, releases the lock,
# and hands back. Nothing un-gated can reach the target branch.
#
# Ported + generalized from VeHagita's scripts/agent-wt/vh-land.sh
# (D085 / #T070 there). Config: see maple-lib.sh header + plugin/README.md.
# CANONICAL keys (docs/standard-architecture.md; reconciled #T11 — this used
# to read an invented `worktree.gate.*` block, now retired):
#   ci.prePushTier   default "gate"
#   ci.tiers.<name>  shell command string to run as the gate for that tier —
#                    e.g. {"fast": "npm run ci:fast", "gate": "npm run
#                    ci:gate"}. No default: if a tier has no configured
#                    command, maple-land refuses to land ungated rather than
#                    guess.

set -euo pipefail
. "$(dirname "$0")/maple-lib.sh"

DEFAULT_TIER="$(maple_cfg ci.prePushTier gate)"
TIER="$DEFAULT_TIER" KEEP=false PUSH=true
while [ $# -gt 0 ]; do
  case "$1" in
    --tier)    TIER="${2:-}"; shift ;;
    --keep)    KEEP=true ;;
    --no-push) PUSH=false ;;
    -*)        maple_die "unknown flag: $1" ;;
    *)         maple_die "unexpected arg: $1" ;;
  esac
  shift
done

GATE_CMD="$(maple_cfg "ci.tiers.$TIER" '')"
if [ -z "$GATE_CMD" ]; then
  maple_die "no gate command configured for tier '$TIER' (maple.config.json ci.tiers.$TIER). Refusing to land ungated — configure a command, or pass --tier for one that has one. If maple.config.json itself looks wrong, run: node \"\$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs\""
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
maple_is_agent_branch "$BRANCH" \
  || maple_die "not on an agent branch (HEAD=$BRANCH, expected pattern '$MAPLE_NAME_PATTERN'). maple-land runs from inside a maple-start worktree."
SLUG="$(maple_slug_from_branch "$BRANCH")"
WT_DIR="$(git rev-parse --show-toplevel)"

# Clean tree required — uncommitted work means the session isn't done.
if [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  maple_die "working tree not clean. Commit (or stash) before landing — maple-land integrates COMMITS."
fi

# ── acquire the global lock for the whole rebase->gate->push window ──────────
maple_lock_acquire "$SLUG"
LAND_LOCK_JS="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/../..}/scripts/prepush/land-lock.sh"
LAND_REF="refs/heads/$MAPLE_TARGET"
land_lock_release() { bash "$LAND_LOCK_JS" release --remote "$MAPLE_REMOTE" --ref "$LAND_REF" --id "${PP_LAND_HOLDER_ID:-}" 2>/dev/null || true; }
trap 'land_lock_release; maple_lock_release' EXIT INT TERM

# The PER-BRANCH landing lock: the same one the pre-push hook takes, so a raw
# `git push` and /wt-land exclude each other (the global lock above only ever
# excluded other /wt-land runs). Waits - printing who holds it - never fails for
# waiting; exports the holder id so this run's own `git push` (and its hook)
# re-enter the lock instead of waiting on us.
maple_log "taking the landing lock on $MAPLE_TARGET …"
LAND_ENV="$(bash "$LAND_LOCK_JS" acquire --remote "$MAPLE_REMOTE" --ref "$LAND_REF" --sha "$(git rev-parse HEAD)" --pid $$ --no-fresh)" \
  || maple_die "could not take the landing lock on $MAPLE_TARGET (see the holder above). Nothing pushed."
eval "$LAND_ENV"

maple_log "fetching $MAPLE_REMOTE/$MAPLE_TARGET …"
git fetch "$MAPLE_REMOTE" "$MAPLE_TARGET" --quiet \
  || maple_die "fetch failed — cannot determine the integration tip."

BASE="$MAPLE_REMOTE/$MAPLE_TARGET"
AHEAD="$(git rev-list --count "$BASE..$BRANCH")"
maple_log "rebasing $BRANCH ($AHEAD commit(s)) onto $BASE …"
if ! git rebase "$BASE"; then
  git rebase --abort 2>/dev/null || true
  maple_die "rebase onto $BASE hit conflicts. Resolve in this worktree, commit, then re-run maple-land."
fi

# ── hooks must be fail-closed before anything is pushed ──────────────────────
# The push below fires the repo's pre-push hook; if this clone's hooksPath is the
# relative husky one and this worktree never ran `npm ci`, git would skip it and
# the push would go out ungated. Repair (idempotent) and verify, or refuse.
if [ -d "$WT_DIR/.husky" ]; then
  HOOKS_JS="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/../..}/scripts/prepush/install-hooks.mjs"
  ( cd "$WT_DIR" && node "$HOOKS_JS" --quiet && node "$HOOKS_JS" --check --quiet )     || maple_die "git hooks are not fail-closed in this clone, so the push would run no gate. Nothing pushed. Run: node \"$HOOKS_JS\""
fi

# ── the gate (serialized by the lock) ────────────────────────────────────────
maple_log "running gate ($TIER): $GATE_CMD  (this is the enforcement — may take minutes) …"
if ! ( cd "$WT_DIR" && eval "$GATE_CMD" ); then
  maple_die "gate ($TIER) FAILED — nothing pushed. Fix in this worktree and re-run maple-land."
fi
maple_ok "gate passed"

# ── quality gate: per-function Jev audit of changed functions only ──────────
# Runs AFTER the repo's own CI gate is green and BEFORE the merge/push, so a
# red quality gate never lands. Skipped entirely when the target repo has no
# quality.jevAudit block, or has one with enabled:false — see
# plugin/scripts/jev/audit/README.md and docs/decisions.md D051.
QUALITY_ENABLED="$(maple_cfg quality.jevAudit.enabled false)"
if [ "$QUALITY_ENABLED" = "true" ]; then
  QUALITY_SCRIPT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/../..}/scripts/jev/audit/run.mjs"
  maple_log "running quality gate (changed functions vs $BASE) …"
  # $BASE (the just-fetched remote tip we rebased onto), NOT the bare
  # "$MAPLE_TARGET": the audit merge-bases against whatever ref it is given,
  # and the LOCAL target branch in the main checkout is routinely stale or
  # diverged, which turned every landing into an audit of dozens of other
  # people's commits (EasyCaller, 2026-09-24: 638 functions for a bash-only
  # change, 10 unrelated blocking findings).
  if ! ( cd "$WT_DIR" && node "$QUALITY_SCRIPT" --gate --base "$BASE" ); then
    maple_die "quality gate FAILED — nothing pushed. See the findings above; fix or add a documented 'jev-audit: accept <rule> — <reason>' comment, then re-run maple-land."
  fi
  maple_ok "quality gate passed"
else
  maple_log "quality gate skipped (quality.jevAudit.enabled is not true)"
fi

# ── push: a guaranteed fast-forward, because we held the lock end-to-end ─────
if $PUSH; then
  maple_log "pushing $BRANCH -> $MAPLE_REMOTE/$MAPLE_TARGET (fast-forward) …"
  if ! git push "$MAPLE_REMOTE" "HEAD:$MAPLE_TARGET"; then
    maple_die "push to $MAPLE_TARGET rejected (non-ff?). Another machine may have advanced it — re-run maple-land to re-rebase. NOT force-pushing."
  fi
  maple_ok "landed: $BRANCH integrated into $MAPLE_TARGET"
  if TASK_REF="$(git config --get "branch.$BRANCH.maple-task" 2>/dev/null)" && [ -n "$TASK_REF" ]; then
    TASK_FIELDS_SCRIPT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/../..}/scripts/agent-wt/task-fields.mjs"
    LANDED_VALUE="$(date +%F) $(git rev-parse --short HEAD)"
    if ! TASK_FIELDS_OUT="$(node "$TASK_FIELDS_SCRIPT" --root "$MAPLE_MAIN_ROOT" --task "$TASK_REF" --set "landed=$LANDED_VALUE" --set "status=review" 2>&1)"; then
      maple_warn "could not update task $TASK_REF: $(printf '%s' "$TASK_FIELDS_OUT" | tr '\r\n' '  ')"
    fi
    git config --unset "branch.$BRANCH.maple-task" 2>/dev/null || true
  fi
else
  maple_warn "--no-push: rebased + gated but NOT pushed. Branch left in place."
fi

maple_lock_release
trap - EXIT INT TERM

# ── prune the worktree + branch ──────────────────────────────────────────────
if $PUSH && ! $KEEP; then
  maple_log "pruning worktree + branch"
  cd "$MAPLE_MAIN_ROOT"   # can't remove the worktree we're standing in
  maple_remove_worktree "$WT_DIR" \
    || maple_warn "couldn't fully remove worktree $WT_DIR (a shell may still be cd'd inside it — maple-reap will finish it)"
  git branch -D "$BRANCH" 2>/dev/null || true
  git ls-remote --exit-code --heads "$MAPLE_REMOTE" "$BRANCH" >/dev/null 2>&1 \
    && git push "$MAPLE_REMOTE" --delete "$BRANCH" 2>/dev/null || true
  maple_ok "cleaned up $SLUG"
  maple_warn "your shell is still inside the removed worktree — cd to $MAPLE_MAIN_ROOT"
else
  maple_log "left worktree in place (--keep or --no-push): $WT_DIR"
fi
