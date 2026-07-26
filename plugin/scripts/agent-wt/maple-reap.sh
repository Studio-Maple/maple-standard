#!/usr/bin/env bash
# maple-reap [--dry-run] [--force] [--stale-hours N]
#
# Keep the worktree set from sprawling. Mechanical cleanup so nobody has to
# remember to do it — wire it to /loop or a schedule. By default it ONLY
# removes work that already landed:
#
#   - <branchPrefix><slug> branches merged into origin/<targetBranch> -> worktree + branch deleted
#   - orphan worktree dirs whose branch is already gone                -> removed
#
# Unmerged branches are NEVER auto-deleted (that's unlanded work). They're
# reported with their idle age; --force removes their *worktree* (freeing
# disk) but keeps the branch so the commits survive.
#
# Ported + generalized from VeHagita's scripts/agent-wt/vh-reap.sh
# (D085 / #T070 there). Config: see maple-lib.sh header + plugin/README.md.
# CANONICAL key (docs/standard-architecture.md; reconciled #T11):
#   worktrees.reap.staleHours   default 24

set -euo pipefail
. "$(dirname "$0")/maple-lib.sh"

DEFAULT_STALE="$(maple_cfg worktrees.reap.staleHours 24)"
DRY=false FORCE=false STALE_HOURS="${MAPLE_STALE_HOURS:-$DEFAULT_STALE}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)     DRY=true ;;
    --force)       FORCE=true ;;
    --stale-hours) STALE_HOURS="${2:-}"; shift ;;
    -*)            maple_die "unknown flag: $1" ;;
    *)             maple_die "unexpected arg: $1" ;;
  esac
  shift
done

do_or_echo() { if $DRY; then printf '\033[35m[dry] %s\033[0m\n' "$*" >&2; else eval "$@"; fi; }

maple_log "fetching $MAPLE_REMOTE/$MAPLE_TARGET (to decide what's merged)…"
git fetch "$MAPLE_REMOTE" "$MAPLE_TARGET" --quiet 2>/dev/null || maple_warn "fetch failed — merged-detection may be stale"
git worktree prune
TARGET_REF="$MAPLE_REMOTE/$MAPLE_TARGET"

is_merged() { git merge-base --is-ancestor "$1" "$TARGET_REF" 2>/dev/null; }
branch_idle_hours() {
  local last now; last="$(git log -1 --format=%ct "$1" 2>/dev/null || echo 0)"
  now="$(date +%s)"; echo $(( (now - last) / 3600 ))
}

reaped=0 kept=0

# `git worktree list --porcelain` prints paths in git's own native form
# (Windows-mixed `C:/...` on Windows); MAPLE_WT_ROOT is POSIX form
# (`/c/...`) there too — normalize once so the prefix match below actually
# fires (BL-2; see maple_norm_path in maple-lib.sh).
MAPLE_WT_ROOT_NORM="$(maple_norm_path "$MAPLE_WT_ROOT")"

# ── pass 1: worktrees under MAPLE_WT_ROOT ────────────────────────────────────
cur_path="" cur_branch=""
flush() {
  [ -n "$cur_path" ] || return 0
  case "$cur_path" in
    "$MAPLE_WT_ROOT_NORM"/*) ;;   # only our human-session worktrees
    *) return 0 ;;
  esac
  [ "$(basename "$cur_path")" = "$MAPLE_PREVIEW_NAME" ] && return 0   # never reap preview

  if [ -z "$cur_branch" ]; then
    maple_warn "orphan/detached worktree (no branch): $cur_path -> removing"
    do_or_echo "maple_remove_worktree '$cur_path'"; reaped=$((reaped+1)); return 0
  fi
  if is_merged "$cur_branch"; then
    maple_ok "merged: $cur_branch -> removing worktree + branch"
    do_or_echo "maple_remove_worktree '$cur_path'"
    do_or_echo "git branch -D '$cur_branch'"; reaped=$((reaped+1))
  else
    local idle; idle="$(branch_idle_hours "$cur_branch")"
    if [ "$idle" -ge "$STALE_HOURS" ] && $FORCE; then
      maple_warn "unmerged but idle ${idle}h: $cur_branch -> --force removing worktree (KEEPING branch)"
      do_or_echo "maple_remove_worktree '$cur_path'"; reaped=$((reaped+1))
    else
      maple_log "keeping unmerged $cur_branch (idle ${idle}h, $cur_path)"; kept=$((kept+1))
    fi
  fi
}
while IFS= read -r line; do
  case "$line" in
    worktree\ *) flush; cur_path="${line#worktree }"; cur_branch="" ;;
    branch\ refs/heads/*) cur_branch="${line#branch refs/heads/}" ;;
    detached) cur_branch="" ;;
  esac
done < <(git worktree list --porcelain)
flush

# ── pass 2: orphan agent/* branches (merged, no worktree) ────────────────────
while IFS= read -r b; do
  [ -n "$b" ] || continue
  git worktree list --porcelain | grep -q "branch refs/heads/$b\$" && continue
  if is_merged "$b"; then
    maple_ok "merged orphan branch (no worktree): $b -> deleting"
    do_or_echo "git branch -D '$b'"; reaped=$((reaped+1))
  else
    maple_log "keeping unmerged orphan branch $b (idle $(branch_idle_hours "$b")h)"; kept=$((kept+1))
  fi
done < <(git for-each-ref --format='%(refname:short)' "refs/heads/${MAPLE_NAME_PREFIX}*${MAPLE_NAME_SUFFIX}")

maple_ok "reap done — ${reaped} removed, ${kept} kept$([ "$DRY" = true ] && echo ' (dry-run)')"
