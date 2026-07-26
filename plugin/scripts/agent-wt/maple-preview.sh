#!/usr/bin/env bash
# maple-preview <slug> [--port N]   |   maple-preview --stop
#
# Point the ONE shared dev server at an agent's branch so you can watch its
# work live and decide whether to direct or stop it ("one server only, never
# auto-increment ports"). Frees the port first, then serves the chosen
# branch from a single dedicated `_preview` worktree (detached HEAD, so it
# never conflicts with the agent's own checkout).
#
# Ported + generalized from VeHagita's scripts/agent-wt/vh-preview.sh
# (D085 / #T070 there). Config: see maple-lib.sh header + plugin/README.md.
# CANONICAL keys (docs/standard-architecture.md; reconciled #T11 — nested
# under the schema's `worktrees.*` block, not an invented top-level one):
#   worktrees.preview.port      default 8080
#   worktrees.preview.workdir   default "."  (dir, relative to worktree root, to run the dev command in)
#   worktrees.preview.command   default "npm run dev -- --port {port} --host 127.0.0.1"
#                                "{port}" is substituted with the resolved port.
#   worktrees.preview.logFile   default ".preview-dev.log" (relative to the preview worktree)

set -euo pipefail
. "$(dirname "$0")/maple-lib.sh"

DEFAULT_PORT="$(maple_cfg worktrees.preview.port 8080)"
SLUG="" PORT="$DEFAULT_PORT" STOP=false
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; shift ;;
    --stop) STOP=true ;;
    -*)     maple_die "unknown flag: $1" ;;
    *)      [ -z "$SLUG" ] && SLUG="$1" || maple_die "unexpected arg: $1" ;;
  esac
  shift
done

PREVIEW_DIR="$(maple_dir_for "$MAPLE_PREVIEW_NAME")"
LOG_REL="$(maple_cfg worktrees.preview.logFile '.preview-dev.log')"
LOG="$PREVIEW_DIR/$LOG_REL"

if $STOP; then
  maple_kill_port "$PORT"
  maple_ok "stopped preview server on :$PORT"
  exit 0
fi

maple_slug_validate "$SLUG"
BRANCH="$(maple_branch_for "$SLUG")"
git show-ref --verify --quiet "refs/heads/$BRANCH" \
  || maple_die "no branch '$BRANCH' — start it first: maple-start $SLUG"

# Ensure the dedicated preview worktree exists (detached HEAD).
if [ ! -d "$PREVIEW_DIR" ]; then
  mkdir -p "$MAPLE_WT_ROOT"
  maple_log "creating preview worktree $PREVIEW_DIR"
  git worktree add --detach "$PREVIEW_DIR" "$BRANCH" >&2
else
  maple_log "checking out $BRANCH (detached) in preview worktree"
  git -C "$PREVIEW_DIR" checkout --detach "$BRANCH" --force >&2
fi
maple_link_node_modules "$PREVIEW_DIR"
maple_link_env_files "$PREVIEW_DIR"

WORKDIR_REL="$(maple_cfg worktrees.preview.workdir '.')"
WORKDIR="$PREVIEW_DIR/$WORKDIR_REL"
CMD_TEMPLATE="$(maple_cfg worktrees.preview.command 'npm run dev -- --port {port} --host 127.0.0.1')"
CMD="${CMD_TEMPLATE//\{port\}/$PORT}"

# One server only: free the port, then (re)start against the preview worktree.
maple_kill_port "$PORT"
maple_log "starting dev server for '$SLUG' on :$PORT …  ($CMD)"
( cd "$WORKDIR" && nohup bash -c "$CMD" >"$LOG" 2>&1 & )

maple_ok "preview of '$SLUG' starting -> http://127.0.0.1:$PORT   (logs: $LOG)"
maple_log "switch branch:  maple-preview <other-slug>     stop:  maple-preview --stop"
