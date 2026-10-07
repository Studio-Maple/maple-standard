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
# Never removed, merged or not, --force or not (all three bypassed by
# maple_remove_worktree's `--force` + `rm -rf` fallback if we didn't check):
#
#   - a worktree with uncommitted changes (`git status --porcelain` non-empty)
#   - a fresh, unstarted worktree: branch tip == the target and its HEAD
#     reflog touched within staleHours. `git worktree add -b agent/x
#     origin/<target>` has zero commits, so it is trivially "merged".
#   - a `git worktree lock`ed worktree
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

# MJ-4: this used to be `eval "$@"` fed a hand-quoted string like
# `"maple_remove_worktree '$cur_path'"` — a path containing an apostrophe
# breaks the quoting, and a crafted worktrees.root that still passes
# isPathShaped() could both truncate the deletion target and execute
# injected shell. Take real positional args and exec them directly — no
# string-building, no eval, no quoting to get wrong.
do_or_echo() { if $DRY; then printf '\033[35m[dry] %s\033[0m\n' "$*" >&2; else "$@"; fi; }

maple_log "fetching $MAPLE_REMOTE/$MAPLE_TARGET (to decide what's merged)…"
git fetch "$MAPLE_REMOTE" "$MAPLE_TARGET" --quiet 2>/dev/null || maple_warn "fetch failed — merged-detection may be stale"
git worktree prune
TARGET_REF="$MAPLE_REMOTE/$MAPLE_TARGET"

is_merged() { git merge-base --is-ancestor "$1" "$TARGET_REF" 2>/dev/null; }
# Uncommitted changes in a worktree. A failed `status` counts as dirty.
wt_dirty() { [ -n "$(git -C "$1" status --porcelain 2>/dev/null || echo unknown)" ]; }
# Hours since the worktree's HEAD reflog was last written (checkout, commit,
# reset…). No reflog / unreadable -> 0, i.e. "just touched": err toward keeping.
wt_head_idle_hours() {
  local gd log now; gd="$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null || true)"
  log="$gd/logs/HEAD"; now="$(date +%s)"
  [ -n "$gd" ] && [ -f "$log" ] || { echo 0; return; }
  echo $(( (now - $(_maple_dir_mtime "$log")) / 3600 ))
}
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

# The loop pack's STANDING worktree (docs/loop-pack.md) — one dedicated
# worktree on `repo.standingLoopBranch`, reused cycle over cycle by
# /dev-burner (plugin/scripts/agent-wt/maple-devburner.sh), never merged or
# pushed by the pack itself. MJ-3: it must get the SAME reap exemption as
# `_preview` (name/branch, not path-based, since maple-devburner.sh creates
# it via `-b`, not through the agent/<slug> pattern) — including under
# `--force`, or an idle overnight standing session looks exactly like an
# abandoned agent worktree and gets deleted mid-run.
STANDING_LOOP_DIR_NAME="_dev-burner"
STANDING_LOOP_BRANCH="$(maple_cfg repo.standingLoopBranch dev-burner)"
# Protected branches — never reaped, whatever the naming pattern says. A
# placeholder that can't be a real branch name stands in for unset keys, so an
# empty value never matches an empty-string case arm.
PROD_BRANCH="$(maple_cfg repo.prodBranch '')";  PROD_BRANCH="${PROD_BRANCH:-:none:}"
DEV_BRANCH="$(maple_cfg repo.devBranch '')";    DEV_BRANCH="${DEV_BRANCH:-:none:}"

# ── pass 1: worktrees under MAPLE_WT_ROOT ────────────────────────────────────
cur_path="" cur_branch="" cur_locked=false
flush() {
  [ -n "$cur_path" ] || return 0
  case "$cur_path" in
    "$MAPLE_WT_ROOT_NORM"/*) ;;   # only our human-session worktrees
    *) return 0 ;;
  esac
  [ "$(basename "$cur_path")" = "$MAPLE_PREVIEW_NAME" ] && return 0   # never reap preview
  # D066: `_`-prefixed dirs are infrastructure worktrees owned by a running tool, never agent sessions:
  # `_land` (the landing queue's integration worktree), `_heavy-<sha>` (a scheduled heavy run).
  case "$(basename "$cur_path")" in _*) return 0 ;; esac
  [ "$(basename "$cur_path")" = "$STANDING_LOOP_DIR_NAME" ] && return 0   # never reap the standing loop-pack worktree (MJ-3)
  [ "$cur_branch" = "$STANDING_LOOP_BRANCH" ] && return 0                 # ...or its branch, by name, defensively
  if $cur_locked; then
    maple_log "keeping ${cur_branch:-detached worktree} — locked (git worktree lock), never reaped ($cur_path)"; kept=$((kept+1)); return 0
  fi

  # Ownership guard. When worktrees lived in a sibling `<repo>-wt` dir only our
  # own scripts ever wrote there, so "under MAPLE_WT_ROOT" meant "ours". Since
  # the root moved inside the repo (D055, `.worktrees`), it is the natural place
  # for ANY worktree — a session parked a worktree of `main` itself there as its
  # merge base, `main` is trivially "merged into origin/main", and reap deleted
  # both the worktree and the local `main` branch. Path is no longer proof of
  # ownership; the branch name is. Reap only what matches the naming pattern,
  # and never a protected branch even if the pattern would match it.
  if [ -n "$cur_branch" ]; then
    case "$cur_branch" in
      "$MAPLE_TARGET"|"$PROD_BRANCH"|"$DEV_BRANCH")
        maple_log "keeping $cur_branch — protected branch, never reaped ($cur_path)"; kept=$((kept+1)); return 0 ;;
    esac
    case "$cur_branch" in
      "$MAPLE_NAME_PREFIX"*"$MAPLE_NAME_SUFFIX") ;;
      *) maple_log "keeping $cur_branch — not a ${MAPLE_NAME_PREFIX}<slug>${MAPLE_NAME_SUFFIX} branch, not ours to reap ($cur_path)"; kept=$((kept+1)); return 0 ;;
    esac
  fi

  if [ -z "$cur_branch" ]; then
    # Detached HEAD: its commits may be reachable from NO branch, so removing it
    # can destroy work outright. Remove only when the tree is clean AND HEAD is
    # already contained in the target; anything else is kept for a human.
    local head
    head="$(git -C "$cur_path" rev-parse HEAD 2>/dev/null || true)"
    if [ -n "$head" ] && ! wt_dirty "$cur_path" && is_merged "$head"; then
      maple_warn "detached worktree, clean and merged: $cur_path -> removing"
      remove_or_keep "$cur_path" && reaped=$((reaped+1))
    else
      maple_log "keeping detached worktree — dirty or unmerged commits, needs a human ($cur_path)"; kept=$((kept+1))
    fi
    return 0
  fi
  # Uncommitted work is lost by removal whether or not the branch landed.
  if wt_dirty "$cur_path"; then
    maple_log "keeping $cur_branch — uncommitted changes in the worktree ($cur_path)"; kept=$((kept+1)); return 0
  fi
  if is_merged "$cur_branch"; then
    # Tip == target with a recently touched HEAD reflog is a worktree that was
    # just created and not started, not one that landed. Landed-by-fast-forward
    # looks the same, so it waits out staleHours and goes on a later run.
    local head_idle
    if [ "$(git rev-parse "$cur_branch" 2>/dev/null)" = "$(git rev-parse "$TARGET_REF" 2>/dev/null)" ]; then
      head_idle="$(wt_head_idle_hours "$cur_path")"
      if [ "$head_idle" -lt "$STALE_HOURS" ]; then
        maple_log "keeping $cur_branch — at the target tip and active ${head_idle}h ago, a fresh worktree ($cur_path)"; kept=$((kept+1)); return 0
      fi
    fi
    maple_ok "merged: $cur_branch -> removing worktree + branch"
    if remove_or_keep "$cur_path"; then
      do_or_echo git branch -D "$cur_branch"; reaped=$((reaped+1))
    fi
  else
    local idle; idle="$(branch_idle_hours "$cur_branch")"
    if [ "$idle" -ge "$STALE_HOURS" ] && $FORCE; then
      maple_warn "unmerged but idle ${idle}h: $cur_branch -> --force removing worktree (KEEPING branch)"
      remove_or_keep "$cur_path" && reaped=$((reaped+1))
    else
      maple_log "keeping unmerged $cur_branch (idle ${idle}h, $cur_path)"; kept=$((kept+1))
    fi
  fi
}
while IFS= read -r line; do
  case "$line" in
    worktree\ *) flush; cur_path="${line#worktree }"; cur_branch=""; cur_locked=false ;;
    branch\ refs/heads/*) cur_branch="${line#branch refs/heads/}" ;;
    detached) cur_branch="" ;;
    locked|locked\ *) cur_locked=true ;;
  esac
done < <(git worktree list --porcelain)
flush

# ── pass 2: orphan agent/* branches (merged, no worktree) ────────────────────
while IFS= read -r b; do
  [ -n "$b" ] || continue
  [ "$b" = "$STANDING_LOOP_BRANCH" ] && continue   # never reap the standing loop-pack branch (MJ-3)
  case "$b" in "$MAPLE_TARGET"|"$PROD_BRANCH"|"$DEV_BRANCH") continue ;; esac   # protected — matters when namePattern has no prefix
  git worktree list --porcelain | grep -q "branch refs/heads/$b\$" && continue
  if is_merged "$b"; then
    maple_ok "merged orphan branch (no worktree): $b -> deleting"
    do_or_echo git branch -D "$b"; reaped=$((reaped+1))
  else
    maple_log "keeping unmerged orphan branch $b (idle $(branch_idle_hours "$b")h)"; kept=$((kept+1))
  fi
done < <(git for-each-ref --format='%(refname:short)' "refs/heads/${MAPLE_NAME_PREFIX}*${MAPLE_NAME_SUFFIX}")

maple_ok "reap done — ${reaped} removed, ${kept} kept$([ "$DRY" = true ] && echo ' (dry-run)')"
