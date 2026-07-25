#!/usr/bin/env bash
# maple-start <slug> [--fresh-deps] [--no-launch] [--from <ref>]
#
# Create an isolated worktree + ephemeral `<branchPrefix><slug>` branch for
# one parallel Claude session, branched off the latest target branch. Links
# node_modules from the main checkout (or installs fresh) and — unless
# --no-launch — opens a Claude session there (tmux window/session if
# available).
#
# Ported + generalized from VeHagita's scripts/agent-wt/vh-start.sh
# (D085 / #T070 there). Config: see maple-lib.sh header + plugin/README.md.
#
# When the session is done, run maple-land from inside the worktree.

set -euo pipefail
. "$(dirname "$0")/maple-lib.sh"

SLUG="" FRESH_DEPS=false LAUNCH=true FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fresh-deps) FRESH_DEPS=true ;;
    --no-launch)  LAUNCH=false ;;
    --from)       FROM="${2:-}"; shift ;;
    -*)           maple_die "unknown flag: $1" ;;
    *)            [ -z "$SLUG" ] && SLUG="$1" || maple_die "unexpected arg: $1" ;;
  esac
  shift
done

maple_slug_validate "$SLUG"
BRANCH="$(maple_branch_for "$SLUG")"
DIR="$(maple_dir_for "$SLUG")"

[ -e "$DIR" ] && maple_die "worktree dir already exists: $DIR"
git show-ref --verify --quiet "refs/heads/$BRANCH" \
  && maple_die "branch '$BRANCH' already exists — pick another slug or land/reap the old one."

# Base off the freshest target tip we can see.
BASE="${FROM:-$MAPLE_REMOTE/$MAPLE_TARGET}"
if [ -z "$FROM" ]; then
  maple_log "fetching $MAPLE_REMOTE/$MAPLE_TARGET …"
  git fetch "$MAPLE_REMOTE" "$MAPLE_TARGET" --quiet 2>/dev/null \
    || maple_warn "fetch failed — basing off local $MAPLE_TARGET instead"
  git rev-parse --verify --quiet "$BASE" >/dev/null || BASE="$MAPLE_TARGET"
fi

mkdir -p "$MAPLE_WT_ROOT"
maple_log "creating worktree $DIR on $BRANCH (base: $BASE)"
git worktree add -b "$BRANCH" "$DIR" "$BASE" >&2

if $FRESH_DEPS; then
  FRESH_CMD="$(maple_cfg worktree.freshDepsCommand 'npm ci')"
  maple_log "installing fresh deps ($FRESH_CMD)"
  ( cd "$DIR" && eval "$FRESH_CMD" ) >&2 || maple_warn "fresh-deps command failed"
else
  maple_link_node_modules "$DIR"
fi
maple_link_env_files "$DIR"   # gitignored dev env (build + dev server may need it)

maple_ok "worktree ready: $DIR  (branch $BRANCH)"
maple_log "land it when done:   cd '$DIR' && bash \"\$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-land.sh\""
maple_log "preview it:          bash \"\$CLAUDE_PLUGIN_ROOT/scripts/agent-wt/maple-preview.sh\" $SLUG"

# ── launch a Claude session in the worktree ──────────────────────────────────
if $LAUNCH; then
  if command -v tmux >/dev/null 2>&1 && command -v claude >/dev/null 2>&1; then
    if [ -n "${TMUX:-}" ]; then
      tmux new-window -c "$DIR" -n "$SLUG" 'claude'
      maple_ok "opened tmux window '$SLUG' running claude"
    else
      tmux new-session -d -s "maple-$SLUG" -c "$DIR" 'claude'
      maple_ok "started detached tmux session 'maple-$SLUG' — attach: tmux attach -t maple-$SLUG"
    fi
  else
    maple_warn "tmux/claude not both on PATH — launch manually:  cd '$DIR' && claude"
  fi
fi

# stdout: the worktree path (parseable by callers/automation, e.g. EnterWorktree)
printf '%s\n' "$DIR"
