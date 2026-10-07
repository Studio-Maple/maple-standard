# shellcheck shell=bash
# plugin/scripts/agent-wt/maple-queue.sh - the D066 landing QUEUE, sourced by maple-land.sh (after maple-lib.sh).
#
# Why: landings used to be one-at-a-time under a global lock, each paying a full gate, and the lock was STOLEN
# from a live holder once older than a TTL while gates took 11-95 minutes. Now every `maple-land` enqueues its
# branch and whoever finds the owner lock free becomes the QUEUE OWNER and lands everyone queued as ONE batch:
#
#   1. rebase each queued branch, FIFO, onto the target in a throwaway integration worktree
#      (<worktrees.root>/_land); a branch that conflicts is returned to its owner, the rest continue;
#   2. run ONE gate on the combined tip;
#   3. fast-forward push it, mark every branch landed;
#   4. on a red gate, BISECT (gate the first half, ...) to find the breaking branch, return it, rebuild the
#      batch without it and land the rest.
#
# State, all under <git-common-dir>/maple/land-queue/<remote>--<target>/ :
#   entries/<epoch-us>-<pid>-<slug>   one per waiting lander (key=value: slug, branch, wt, pid, mode, at)
#   results/<entry name>              the owner's verdict for it (status=landed|conflict|gate-failed|error)
# The owner lock is MAPLE_LOCK_DIR (<git-common-dir>/maple-land.lock, the same global lock /dev-burner takes).
# A lock is stale ONLY when its holder pid is dead - never because it is old (maple-lib.sh).

MAPLE_Q_DIR=""
MAPLE_Q_ENTRY=""
MAPLE_Q_POLL="${MAPLE_LAND_POLL:-3}"
MAPLE_Q_TIER="${MAPLE_Q_TIER:-gate}"        # set by maple-land.sh
MAPLE_Q_GATE_CMD="${MAPLE_Q_GATE_CMD:-}"    # set by maple-land.sh (ci.tiers.<tier>)

maple_q_init() {
  local key="${MAPLE_REMOTE}--${MAPLE_TARGET}"
  key="${key//[^A-Za-z0-9._-]/_}"
  MAPLE_Q_DIR="$MAPLE_COMMON_DIR/maple/land-queue/$key"
  mkdir -p "$MAPLE_Q_DIR/entries" "$MAPLE_Q_DIR/results"
}

# maple_q_get <file> <key> -> stdout (first match)
maple_q_get() {
  local k v
  while IFS='=' read -r k v; do
    if [ "$k" = "$2" ]; then printf '%s' "$v"; return 0; fi
  done <"$1" 2>/dev/null
  return 0
}

# maple_q_enqueue <slug> <branch> <wt> -> MAPLE_Q_ENTRY (the entry's name)
maple_q_enqueue() {
  local ts name tmp
  ts="${EPOCHREALTIME:-$(date +%s)}"; ts="${ts/[.,]/}"
  name="${ts}-$$-$1"
  tmp="$MAPLE_Q_DIR/.tmp-$name"
  printf 'slug=%s\nbranch=%s\nwt=%s\npid=%s\nat=%s\n' "$1" "$2" "$3" "$$" "$(date +%s)" >"$tmp"
  mv -f "$tmp" "$MAPLE_Q_DIR/entries/$name"
  export MAPLE_Q_ENTRY="$name"
}

maple_q_dequeue() { # <entry name>: drop the entry and any verdict
  rm -f "$MAPLE_Q_DIR/entries/$1" "$MAPLE_Q_DIR/results/$1" 2>/dev/null || true
}

# maple_q_live -> array MAPLE_Q_LIVE of entry names (FIFO). Entries whose lander is dead are dropped.
maple_q_live() {
  local f name pid
  MAPLE_Q_LIVE=()
  for f in "$MAPLE_Q_DIR"/entries/*; do
    [ -f "$f" ] || continue
    name="${f##*/}"
    pid="$(maple_q_get "$f" pid)"
    if [ -n "$pid" ] && ! _maple_pid_alive "$pid"; then
      maple_warn "dropping queue entry '$name' - its lander (pid $pid) is gone"
      maple_q_dequeue "$name"
      continue
    fi
    MAPLE_Q_LIVE+=("$name")
  done
}

# maple_q_position <entry> -> 1-based place in the live queue (0 when absent)
maple_q_position() {
  local i=0 n
  maple_q_live
  for n in "${MAPLE_Q_LIVE[@]}"; do
    i=$((i + 1))
    if [ "$n" = "$1" ]; then printf '%s' "$i"; return 0; fi
  done
  printf '0'
}

maple_q_result() { # <entry> <status> <message> [sha]
  printf 'status=%s\nsha=%s\nmessage=%s\n' "$2" "${4:-}" "$3" >"$MAPLE_Q_DIR/results/$1.tmp"
  mv -f "$MAPLE_Q_DIR/results/$1.tmp" "$MAPLE_Q_DIR/results/$1"
}

# ── the owner lock ───────────────────────────────────────────────────────────
MAPLE_Q_OWNER=false

# maple_q_try_owner -> 0 when this process now holds the owner lock. Never takes it from a live holder.
maple_q_try_owner() {
  local stale_pid mutex="$MAPLE_LOCK_DIR.reclaim" got=1 mt now
  if mkdir "$MAPLE_LOCK_DIR" 2>/dev/null; then _maple_lock_meta "land-queue"; MAPLE_Q_OWNER=true; return 0; fi
  _maple_lock_is_stale || return 1
  # Reclaiming a dead owner's lock is a check-then-act sequence (judge stale, remove, mkdir). Two contenders doing
  # it at once could each remove the OTHER's fresh lock and both believe they own the queue (two integration
  # worktrees on one path), so the reclaim itself is serialised by a second mkdir mutex and the staleness
  # judgement is repeated inside it.
  if mkdir "$mutex" 2>/dev/null; then
    if _maple_lock_is_stale; then
      stale_pid="$(_maple_lock_pid)"
      maple_warn "reclaiming the land lock (holder pid ${stale_pid:-?} is gone)"
      rm -rf "$MAPLE_LOCK_DIR"
    fi
    if mkdir "$MAPLE_LOCK_DIR" 2>/dev/null; then _maple_lock_meta "land-queue"; MAPLE_Q_OWNER=true; got=0; fi
    rmdir "$mutex" 2>/dev/null || true
    return "$got"
  fi
  # someone else is reclaiming right now; a mutex left behind by a reclaimer that died is cleared after 60 s
  mt="$(_maple_dir_mtime "$mutex")"; now="$(_maple_now)"
  if [ $((now - mt)) -gt 60 ]; then rmdir "$mutex" 2>/dev/null || true; fi
  return 1
}

maple_q_release_owner() {
  if $MAPLE_Q_OWNER; then maple_lock_release; MAPLE_Q_OWNER=false; fi
}

# ── the integration worktree + batch ────────────────────────────────────────
MAPLE_Q_INTEG=""

maple_q_integ_new() { # <base sha>
  MAPLE_Q_INTEG="$MAPLE_WT_ROOT/_land"
  maple_ensure_gitignored '.worktrees/' >/dev/null 2>&1 || true
  if [ -e "$MAPLE_Q_INTEG" ] || git worktree list --porcelain | grep -q "^worktree .*/_land\$"; then
    maple_remove_worktree "$MAPLE_Q_INTEG"       || maple_die "could not safely remove the stale integration worktree $MAPLE_Q_INTEG (links not proven stripped, D069). Nothing was deleted; clear it by hand."
  fi
  mkdir -p "$MAPLE_WT_ROOT"
  git worktree add --detach "$MAPLE_Q_INTEG" "$1" >&2
  maple_link_node_modules "$MAPLE_Q_INTEG"
  maple_link_env_files "$MAPLE_Q_INTEG"
  if [ -d "$MAPLE_Q_INTEG/.husky" ]; then
    ( cd "$MAPLE_Q_INTEG" && node "${CLAUDE_PLUGIN_ROOT:-$(dirname "${BASH_SOURCE[0]}")/../..}/scripts/prepush/install-hooks.mjs" --quiet ) \
      || maple_die "git hooks are not fail-closed in this clone, so the push would run no gate. Nothing pushed."
  fi
}

maple_q_integ_drop() {
  if [ -n "$MAPLE_Q_INTEG" ] && [ -e "$MAPLE_Q_INTEG" ]; then
    ( cd "$MAPLE_MAIN_ROOT" && maple_remove_worktree "$MAPLE_Q_INTEG" ) \
      || maple_warn "KEPT integration worktree $MAPLE_Q_INTEG - removal refused (D069); the next land retries it or remove it by hand"
  fi
  MAPLE_Q_INTEG=""
}

# maple_q_gate <tip sha> -> exit status of the configured gate command on that tip (run inside the integration worktree)
maple_q_gate() {
  git -C "$MAPLE_Q_INTEG" checkout -q --detach "$1" || return 99
  ( cd "$MAPLE_Q_INTEG" && eval "$MAPLE_Q_GATE_CMD" )
}

# maple_q_batch <entry names...> -> processes one batch. Returns 0 when the batch ended with every entry
# decided (landed or returned), 3 when the push lost a race (caller retries the remaining entries).
maple_q_batch() {
  local -a entries=("$@") acc=() tips=()
  local base tip name branch slug files i n lo hi mid land_env culprit rc rb_ok rb_out

  maple_log "land queue: ${#entries[@]} branch(es) -> $MAPLE_REMOTE/$MAPLE_TARGET"
  git fetch "$MAPLE_REMOTE" "$MAPLE_TARGET" --quiet || { for name in "${entries[@]}"; do maple_q_result "$name" error "fetch of $MAPLE_REMOTE/$MAPLE_TARGET failed"; done; return 0; }
  base="$(git rev-parse "$MAPLE_REMOTE/$MAPLE_TARGET")"
  maple_q_integ_new "$base"
  tip="$base"

  # 1. rebase FIFO onto the moving combined tip; conflicts go back to their owners
  for name in "${entries[@]}"; do
    branch="$(maple_q_get "$MAPLE_Q_DIR/entries/$name" branch)"
    slug="$(maple_q_get "$MAPLE_Q_DIR/entries/$name" slug)"
    if ! git show-ref --verify --quiet "refs/heads/$branch"; then
      maple_q_result "$name" error "branch '$branch' no longer exists"; continue
    fi
    rb_ok=false; rb_out=""; files=""
    for _ in 1 2; do
      git -C "$MAPLE_Q_INTEG" checkout -q -f -B _land-work "refs/heads/$branch" 2>/dev/null || true
      if rb_out="$(git -C "$MAPLE_Q_INTEG" rebase "$tip" 2>&1)"; then rb_ok=true; break; fi
      files="$(git -C "$MAPLE_Q_INTEG" diff --name-only --diff-filter=U 2>/dev/null | tr '\n' ' ')"
      git -C "$MAPLE_Q_INTEG" rebase --abort >/dev/null 2>&1 || true
      # real conflicts name their files; a failure that names none is a transient git/filesystem hiccup: retry once
      [ -n "$files" ] && break
      maple_warn "  (rebase of $slug failed without conflicts - retrying once: ${rb_out##*$'\n'})"
      maple_sleep 1
    done
    if $rb_ok; then
      tip="$(git -C "$MAPLE_Q_INTEG" rev-parse HEAD)"
      acc+=("$name"); tips+=("$tip")
      maple_log "  + $slug rebased (combined tip ${tip:0:10})"
    else
      maple_q_result "$name" conflict "rebase onto $MAPLE_REMOTE/$MAPLE_TARGET (with the branches queued ahead of it) failed: ${files:+conflicts in: $files}${files:-${rb_out##*$'\n'}}"
      maple_warn "  - $slug returned: rebase failed (${files:-${rb_out##*$'\n'}})"
    fi
    git -C "$MAPLE_Q_INTEG" checkout -q --detach "$tip"
    git -C "$MAPLE_Q_INTEG" branch -D _land-work >/dev/null 2>&1 || true
  done
  n="${#acc[@]}"
  if [ "$n" -eq 0 ]; then maple_q_integ_drop; return 0; fi

  # the per-branch landing lock (the same one the pre-push hook takes) for the whole gate + push
  land_env="$(bash "$MAPLE_LAND_LOCK_SH" acquire --remote "$MAPLE_REMOTE" --ref "refs/heads/$MAPLE_TARGET" --sha "$tip" --pid $$ --no-fresh)" \
    || { for name in "${acc[@]}"; do maple_q_result "$name" error "could not take the landing lock on $MAPLE_TARGET"; done; maple_q_integ_drop; return 0; }
  eval "$land_env"
  _maple_q_unlock() { bash "$MAPLE_LAND_LOCK_SH" release --remote "$MAPLE_REMOTE" --ref "refs/heads/$MAPLE_TARGET" --id "${PP_LAND_HOLDER_ID:-}" 2>/dev/null || true; }

  # 2. ONE gate on the combined tip
  maple_log "running ONE gate ($MAPLE_Q_TIER) on the combined tip of $n branch(es): $MAPLE_Q_GATE_CMD"
  rc=0; maple_q_gate "$tip" || rc=$?
  if [ "$rc" -ne 0 ]; then
    maple_warn "gate FAILED on the combined tip"
    if [ "$n" -eq 1 ]; then
      maple_q_result "${acc[0]}" gate-failed "gate ($MAPLE_Q_TIER) failed on this branch rebased onto $MAPLE_REMOTE/$MAPLE_TARGET"
      _maple_q_unlock; maple_q_integ_drop; return 0
    fi
    # 4. bisect: smallest k such that the first k branches are red (0 = the bare target, green by assumption)
    lo=0; hi="$n"
    while [ $((hi - lo)) -gt 1 ]; do
      mid=$(((lo + hi) / 2))
      maple_log "bisect: gating the first $mid of $n branch(es) (tip ${tips[$((mid - 1))]:0:10})"
      if maple_q_gate "${tips[$((mid - 1))]}"; then lo="$mid"; else hi="$mid"; fi
    done
    culprit="${acc[$((hi - 1))]}"
    slug="$(maple_q_get "$MAPLE_Q_DIR/entries/$culprit" slug)"
    maple_warn "bisect: '$slug' breaks the gate - returned to its owner; re-batching the rest"
    maple_q_result "$culprit" gate-failed "the gate went red when this branch joined the batch (bisected over $n branches); fix it and re-run maple-land"
    _maple_q_unlock; maple_q_integ_drop
    return 4   # re-batch the rest
  fi
  maple_ok "gate passed on the combined tip"

  # 3. fast-forward push from the integration worktree (its pre-push hook finds the tree already gated)
  if ! git -C "$MAPLE_Q_INTEG" push "$MAPLE_REMOTE" "$tip:refs/heads/$MAPLE_TARGET"; then
    maple_warn "push of the combined tip was rejected (non-ff: $MAPLE_TARGET moved) - retrying the batch"
    _maple_q_unlock; maple_q_integ_drop
    return 3
  fi
  for i in "${!acc[@]}"; do maple_q_result "${acc[$i]}" landed "landed in a batch of $n" "${tips[$i]}"; done
  maple_ok "landed $n branch(es) as one batch -> $MAPLE_REMOTE/$MAPLE_TARGET (${tip:0:10})"
  _maple_q_unlock; maple_q_integ_drop
  return 0
}

# maple_q_drain: as owner, land everything queued (and whatever arrives meanwhile) until the queue is empty.
maple_q_drain() {
  local -a batch=()
  local name tries=0 rc
  while :; do
    maple_q_live
    batch=()
    for name in "${MAPLE_Q_LIVE[@]}"; do
      [ -f "$MAPLE_Q_DIR/results/$name" ] && continue   # already decided, its lander has not picked it up yet
      batch+=("$name")
    done
    [ "${#batch[@]}" -gt 0 ] || return 0
    rc=0; maple_q_batch "${batch[@]}" || rc=$?
    case "$rc" in
      0) tries=0 ;;
      4) : ;;   # bisect returned one branch; the rest go round again
      3) tries=$((tries + 1))
         if [ "$tries" -ge 3 ]; then
           for name in "${batch[@]}"; do
             [ -f "$MAPLE_Q_DIR/results/$name" ] || maple_q_result "$name" error "push rejected 3 times - $MAPLE_TARGET keeps moving; re-run maple-land"
           done
           tries=0
         fi ;;
    esac
  done
}

# maple_q_await <entry> -> prints the verdict file's path when it appears; also tries to become the owner.
# Never returns until a verdict exists or MAPLE_LAND_WAIT passes (then exit 1 via maple_die).
maple_q_await() {
  local entry="$1" waited=0 wait="${MAPLE_LAND_WAIT:-14400}" next_progress=0 pos
  while :; do
    [ -f "$MAPLE_Q_DIR/results/$entry" ] && return 0
    if maple_q_try_owner; then
      maple_q_drain
      maple_q_release_owner
      [ -f "$MAPLE_Q_DIR/results/$entry" ] && return 0
      maple_die "internal: the queue drained without a verdict for '$entry'"
    fi
    if [ "$waited" -ge "$wait" ]; then
      maple_q_dequeue "$entry"
      maple_die "gave up after ${waited}s waiting in the land queue (owner: slug=$(_maple_lock_slug) pid=$(_maple_lock_pid))."
    fi
    if [ "$waited" -ge "$next_progress" ]; then
      pos="$(maple_q_position "$entry")"
      maple_log "queued (#$pos); the queue owner (slug=$(_maple_lock_slug) pid=$(_maple_lock_pid)) lands everyone as one batch - waited ${waited}s"
      next_progress=$((waited + 30))
    fi
    maple_sleep "$MAPLE_Q_POLL"
    waited=$((waited + MAPLE_Q_POLL))
  done
}

# maple_q_wait_owner: block until THIS process holds the owner lock (used by --no-push: serialised, never queued).
maple_q_wait_owner() {
  local waited=0 wait="${MAPLE_LAND_WAIT:-14400}" next_progress=0
  while ! maple_q_try_owner; do
    if [ "$waited" -ge "$wait" ]; then maple_die "gave up after ${waited}s waiting for the land lock (slug=$(_maple_lock_slug) pid=$(_maple_lock_pid))."; fi
    if [ "$waited" -ge "$next_progress" ]; then
      maple_log "land lock held by slug=$(_maple_lock_slug) pid=$(_maple_lock_pid) - waiting (${waited}s)"
      next_progress=$((waited + 30))
    fi
    maple_sleep "$MAPLE_Q_POLL"
    waited=$((waited + MAPLE_Q_POLL))
  done
}
