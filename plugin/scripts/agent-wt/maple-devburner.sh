#!/usr/bin/env bash
# maple-devburner.sh ensure
#
# Ensure the STANDING dev-burner worktree + branch exist (docs/loop-pack.md
# orchestrator step 1). Unlike maple-start.sh's ephemeral `agent/<slug>`
# worktrees, this is ONE dedicated worktree on a fixed branch
# (`repo.standingLoopBranch`, default "dev-burner"), created once from the
# target's tip and reused cycle over cycle:
#
#   - First run (no worktree, no branch): create both from the freshest
#     $MAPLE_REMOTE/$MAPLE_TARGET (D008 — $MAPLE_TARGET resolves to
#     repo.devBranch when set, so this targets the dev checkout, never prod).
#   - Worktree missing but the branch already exists: re-attach a worktree to
#     it (recovering from a worktree wipe without losing the branch/commits).
#   - Worktree present AND clean at cycle start: rebase onto the fresh
#     target tip — "only when clean at cycle start, never mid-cycle"
#     (docs/loop-pack.md). A conflicted rebase aborts and leaves the branch
#     as it was; it does NOT force anything.
#   - Worktree present but dirty: leave it alone this cycle (a loop is
#     presumably mid-commit-or-revert; rebasing under it would be unsafe).
#
# Reuses maple-lib.sh's GLOBAL land lock (the same one maple-land.sh holds
# for its whole rebase->gate->push window) around the fetch+rebase here, so
# this can never interleave with a concurrent /wt-land fetch/rebase/push on
# the same remote target — "reuse the agent-wt lock discipline so it can't
# collide with /wt-land" (docs/tasks.md #T8).
#
# Prints the worktree's absolute path on stdout (parseable, e.g. for
# EnterWorktree) — everything else goes to stderr via maple_log/warn/ok.

set -euo pipefail
. "$(dirname "$0")/maple-lib.sh"

SUB="${1:-ensure}"
[ "$SUB" = "ensure" ] || maple_die "unknown subcommand '$SUB' (only 'ensure' exists)"

STANDING_BRANCH="$(maple_cfg repo.standingLoopBranch dev-burner)"
DIR="$MAPLE_WT_ROOT/_dev-burner"

mkdir -p "$MAPLE_WT_ROOT"

maple_lock_acquire "dev-burner"
trap 'maple_lock_release' EXIT INT TERM

maple_log "fetching $MAPLE_REMOTE/$MAPLE_TARGET …"
git fetch "$MAPLE_REMOTE" "$MAPLE_TARGET" --quiet 2>/dev/null \
  || maple_warn "fetch failed — proceeding with local refs"

BRANCH_EXISTS=false
git show-ref --verify --quiet "refs/heads/$STANDING_BRANCH" && BRANCH_EXISTS=true

if [ ! -d "$DIR" ]; then
  if $BRANCH_EXISTS; then
    maple_log "worktree missing but branch '$STANDING_BRANCH' already exists — re-attaching a worktree to it"
    git worktree add "$DIR" "$STANDING_BRANCH" >&2
  else
    BASE="$MAPLE_REMOTE/$MAPLE_TARGET"
    git rev-parse --verify --quiet "$BASE" >/dev/null || BASE="$MAPLE_TARGET"
    maple_log "creating standing worktree $DIR on new branch '$STANDING_BRANCH' (base: $BASE)"
    git worktree add -b "$STANDING_BRANCH" "$DIR" "$BASE" >&2
  fi
  maple_link_node_modules "$DIR"
  maple_link_env_files "$DIR"
  maple_ok "standing dev-burner worktree ready: $DIR (branch $STANDING_BRANCH)"
else
  maple_ok "standing worktree already present: $DIR"
  if [ -z "$(git -C "$DIR" status --porcelain)" ]; then
    maple_log "clean at cycle start — rebasing $STANDING_BRANCH onto fresh $MAPLE_REMOTE/$MAPLE_TARGET"
    if ! git -C "$DIR" rebase "$MAPLE_REMOTE/$MAPLE_TARGET"; then
      git -C "$DIR" rebase --abort 2>/dev/null || true
      maple_warn "rebase onto $MAPLE_TARGET hit conflicts — left $STANDING_BRANCH as-is. If this persists, resolve manually in $DIR."
    fi
  else
    maple_warn "dev-burner worktree not clean — skipping rebase this cycle (never rebase mid-cycle)"
  fi
fi

maple_lock_release
trap - EXIT INT TERM

printf '%s\n' "$DIR"
