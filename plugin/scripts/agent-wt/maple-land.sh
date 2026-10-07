#!/usr/bin/env bash
# maple-land [--tier <name>] [--keep] [--no-push]
#
# Run from INSIDE an agent worktree to integrate it back into the target branch (D066: via a QUEUE, see
# maple-queue.sh). It:
#
#   1. enqueues this branch (<git-common-dir>/maple/land-queue/);
#   2. whoever finds the queue-owner lock free becomes the OWNER and lands everyone queued as ONE batch:
#      rebases each branch FIFO onto the freshest <remote>/<targetBranch> in an integration worktree
#      (a branch that conflicts is returned to its owner), runs ONE gate for --tier on the combined tip
#      (a red gate is bisected to the breaking branch, which is returned; the rest land), and
#      fast-forward-pushes;
#   3. every lander gets its own verdict (landed / conflict / gate failed) and, when landed, prunes its
#      worktree + branch.
#
# The owner lock is NEVER taken from a live process: it is stale only when its holder pid is dead.
# The Jev quality audit no longer runs here: it moved to the heavy tier (D066 amending D059).
#
# --no-push  rebase + gate THIS branch alone (serialised behind the owner lock, never queued), push nothing.
# --keep     keep the worktree + branch after landing.
#
# Red gate, rebase conflict, or non-ff push -> it refuses and hands back. Nothing un-gated can reach the target.
#
# Ported + generalized from VeHagita's scripts/agent-wt/vh-land.sh (D085 / #T070 there). Config: see
# maple-lib.sh header + plugin/README.md. CANONICAL keys (docs/standard-architecture.md; reconciled #T11):
#   ci.prePushTier   default "gate"
#   ci.tiers.<name>  shell command string to run as the gate for that tier — e.g. {"fast": "pnpm ci:fast",
#                    "gate": "pnpm ci:gate", "heavy": "pnpm ci:heavy"}. No default: if a tier has no
#                    configured command, maple-land refuses to land ungated rather than guess.

set -euo pipefail
. "$(dirname "$0")/maple-lib.sh"
. "$(dirname "$0")/maple-queue.sh"

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
git update-index -q --refresh 2>/dev/null || true   # clear stat-only noise (autocrlf checkouts) before judging cleanliness
if [ -n "$(git status --porcelain)" ]; then
  git status --short >&2
  maple_die "working tree not clean. Commit (or stash) before landing — maple-land integrates COMMITS."
fi

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/../..}"
MAPLE_LAND_LOCK_SH="$PLUGIN_ROOT/scripts/prepush/land-lock.sh"
MAPLE_Q_GATE_CMD="$GATE_CMD"
MAPLE_Q_TIER="$TIER"
maple_q_init

# ── hooks must be fail-closed before anything is pushed ──────────────────────
# The push fires the repo's pre-push hook; if this clone's hooksPath is the relative husky one and this
# worktree never ran `npm ci`, git would skip it and the push would go out ungated. Repair (idempotent)
# and verify, or refuse. (The owner's integration worktree repeats this for itself.)
if $PUSH && [ -d "$WT_DIR/.husky" ]; then
  HOOKS_JS="$PLUGIN_ROOT/scripts/prepush/install-hooks.mjs"
  ( cd "$WT_DIR" && node "$HOOKS_JS" --quiet && node "$HOOKS_JS" --check --quiet )     || maple_die "git hooks are not fail-closed in this clone, so the push would run no gate. Nothing pushed. Run: node \"$HOOKS_JS\""
fi

if $PUSH; then
  # ── queue: enqueue, then wait for a verdict (becoming the batch owner when the lock is free) ─────────────
  maple_q_enqueue "$SLUG" "$BRANCH" "$WT_DIR"
  QENTRY="$MAPLE_Q_ENTRY"
  trap 'maple_q_release_owner; [ -f "$MAPLE_Q_DIR/results/$QENTRY" ] || maple_q_dequeue "$QENTRY"; maple_q_integ_drop' EXIT INT TERM
  maple_log "queued '$SLUG' for $MAPLE_TARGET (position $(maple_q_position "$QENTRY"))"
  maple_q_await "$QENTRY"

  RESULT_FILE="$MAPLE_Q_DIR/results/$QENTRY"
  STATUS="$(maple_q_get "$RESULT_FILE" status)"
  MESSAGE="$(maple_q_get "$RESULT_FILE" message)"
  LANDED_SHA="$(maple_q_get "$RESULT_FILE" sha)"
  maple_q_dequeue "$QENTRY"
  trap - EXIT INT TERM
  maple_q_release_owner
  case "$STATUS" in
    landed) maple_ok "landed: $BRANCH integrated into $MAPLE_TARGET (${LANDED_SHA:0:10}; $MESSAGE)" ;;
    conflict)    maple_die "NOT landed - $MESSAGE. Resolve in this worktree (git fetch $MAPLE_REMOTE && git rebase $MAPLE_REMOTE/$MAPLE_TARGET), commit, then re-run maple-land." ;;
    gate-failed) maple_die "NOT landed - $MESSAGE. Fix in this worktree and re-run maple-land." ;;
    *)           maple_die "NOT landed - ${MESSAGE:-unknown error} (status ${STATUS:-none}). Re-run maple-land." ;;
  esac

  if TASK_REF="$(git config --get "branch.$BRANCH.maple-task" 2>/dev/null)" && [ -n "$TASK_REF" ]; then
    TASK_FIELDS_SCRIPT="$PLUGIN_ROOT/scripts/agent-wt/task-fields.mjs"
    LANDED_VALUE="$(date +%F) ${LANDED_SHA:0:7}"
    if ! TASK_FIELDS_OUT="$(node "$TASK_FIELDS_SCRIPT" --root "$MAPLE_MAIN_ROOT" --task "$TASK_REF" --set "landed=$LANDED_VALUE" --set "status=review" 2>&1)"; then
      maple_warn "could not update task $TASK_REF: $(printf '%s' "$TASK_FIELDS_OUT" | tr '\r\n' '  ')"
    fi
    git config --unset "branch.$BRANCH.maple-task" 2>/dev/null || true
  fi
else
  # ── --no-push: serialised behind the owner lock (never queued, never pushed) ────────────────────────────
  trap 'maple_q_release_owner' EXIT INT TERM
  maple_q_wait_owner
  maple_log "fetching $MAPLE_REMOTE/$MAPLE_TARGET …"
  git fetch "$MAPLE_REMOTE" "$MAPLE_TARGET" --quiet || maple_die "fetch failed — cannot determine the integration tip."
  BASE="$MAPLE_REMOTE/$MAPLE_TARGET"
  maple_log "rebasing $BRANCH ($(git rev-list --count "$BASE..$BRANCH") commit(s)) onto $BASE …"
  if ! git rebase "$BASE"; then
    git rebase --abort 2>/dev/null || true
    maple_die "rebase onto $BASE hit conflicts. Resolve in this worktree, commit, then re-run maple-land."
  fi
  maple_log "running gate ($TIER): $GATE_CMD …"
  if ! ( cd "$WT_DIR" && eval "$GATE_CMD" ); then
    maple_die "gate ($TIER) FAILED — fix in this worktree and re-run maple-land."
  fi
  maple_ok "gate passed"
  maple_warn "--no-push: rebased + gated but NOT pushed. Branch left in place."
  maple_q_release_owner
  trap - EXIT INT TERM
fi

# ── prune the worktree + branch ──────────────────────────────────────────────
if $PUSH && ! $KEEP; then
  maple_log "pruning worktree + branch"
  cd "$MAPLE_MAIN_ROOT"   # can't remove the worktree we're standing in
  if maple_remove_worktree "$WT_DIR"; then
    git branch -D "$BRANCH" 2>/dev/null || true
    git ls-remote --exit-code --heads "$MAPLE_REMOTE" "$BRANCH" >/dev/null 2>&1 \
      && git push "$MAPLE_REMOTE" --delete "$BRANCH" 2>/dev/null || true
    maple_ok "cleaned up $SLUG"
    maple_warn "your shell is still inside the removed worktree — cd to $MAPLE_MAIN_ROOT"
  else
    # D069: removal is fail-closed - nothing was deleted; keep the branch too so the work stays reachable.
    maple_warn "KEPT worktree $WT_DIR and branch $BRANCH - removal refused (see error above: a shell may be cd'd inside, or links could not be proven stripped). Already integrated; maple-reap will retry."
  fi
else
  maple_log "left worktree in place (--keep or --no-push): $WT_DIR"
fi
