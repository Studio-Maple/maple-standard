#!/usr/bin/env bash
# prepush-lib.sh -- affected-only gate helpers. SOURCE this file, do not run it.
#
# Canonical copy: this file (maple-standard plugin, plugin/scripts/prepush/).
# Projects vendor it (EasyCaller: scripts/lib/prepush-lib.sh) so their gate does not
# depend on the plugin being installed. Keep the copies byte-identical (diff on bump).
#
# What it gives a gate script (ci-local.sh):
#   pp_init <root> [refs]  resolve the push range + changed-file set, decide FULL
#   pp_want <id> <re> [x]  "should step <id> run?"  (always yes when FULL)
#   pp_any <re> [x]        any changed path matching <re> (and not <x>)?
#   pp_want_graph <id> <re>  like pp_want, but only when the import graph may have changed
#   pp_list_existing / pp_list_deleted <re> [x]   -> PP_M array
#   pp_ran / pp_skip       one-line "ran / skipped (reason)" per step
#   pp_summary             the table, printed at the end
#   pp_cache_dir <name>    per-checkout cache dir -> $PP_CACHE (never shared across worktrees)
#   pp_lock / pp_unlock    per-checkout lock around cache-writing work
#   pp_heavy_begin/end     machine-wide gate slots (semaphore), taken lazily
#   pp_stamp_*             "this exact tree already passed the gate" stamp
#
# Soundness rules this file enforces (they are why it is safe to skip things):
#   * No resolvable range            -> FULL.   (unsure => run more)
#   * CI_FULL=1 / PP_FORCE_FULL=1    -> FULL.
#   * A path matching PP_FULL_RE changed (the gate scripts, lockfiles, shared
#     configs)                       -> FULL.
#   * A skip is never silent: every step is recorded and printed.
#
# Performance rule (this is why it looks the way it does): on Windows every
# fork costs tens of ms idle and whole SECONDS under load, and a gate makes
# ~40 select decisions. Selection therefore uses only bash builtins ([[ =~ ]],
# arrays, printf -v, read) -- no $(...), no grep/sed/sort in any decision path.
# Only pp_init talks to git (a handful of calls). Needs bash >= 4.4 (empty-array expansion under set -u).

PP_ROOT=""
PP_FULL=0
PP_FULL_REASON=""
PP_BASE=""
PP_FILES=()            # changed paths (relative, '/'-separated)
PP_SUMMARY=()          # "ran ..." / "skipped ..." lines
PP_ADDDEL=()           # paths ADDED or DELETED (a new/removed file changes the import graph)
PP_M=()                # result array of pp_list_*
PP_CACHE=""            # result of pp_cache_dir
PP_COMMON=""           # git common dir
PP_TREE=""             # HEAD tree sha
PP_KEY=""              # per-checkout key
PP_STAMP=""

_pp_zero_re='^0+$'

_pp_now() { # _pp_now <var>
  printf -v "$1" '%(%s)T' -1 2>/dev/null || printf -v "$1" '%s' "$(date +%s)"
}

# ---------------------------------------------------------------------------
# Range + changed set.
# ---------------------------------------------------------------------------
_pp_seen=$'\n'
_pp_add_files() { # add the paths of `git diff --name-status` lines in $1, once each
  local st f
  while IFS=$'\t' read -r st f; do
    [ -n "$f" ] || continue
    case "$st" in A*|D*) PP_ADDDEL+=("$f") ;; esac
    case "$_pp_seen" in *$'\n'"$f"$'\n'*) continue ;; esac
    _pp_seen="$_pp_seen$f"$'\n'
    PP_FILES+=("$f")
  done <<EOF
$1
EOF
}

# Per-checkout key from the path (no hashing fork): the path with every
# non-alphanumeric turned into "_", its last 60 chars when longer. (A negative
# substring offset past the start yields "", so a SHORT path must not be sliced:
# that bug once made every key empty and shared the caches between worktrees.)
_pp_key_for() { # _pp_key_for <path> -> $PP_KEY
  PP_KEY="${1//[^A-Za-z0-9]/_}"
  if [ "${#PP_KEY}" -gt 60 ]; then PP_KEY="${PP_KEY: -60}"; fi
}

# pp_init <root> [refs]
#   refs: the text git feeds a pre-push hook ("<lref> <lsha> <rref> <rsha>" per
#   line). Pass it when invoked from the hook; empty otherwise.
pp_init() {
  PP_ROOT="$1"
  local refs="${2:-}"
  PP_FILES=(); PP_ADDDEL=(); PP_SUMMARY=(); PP_FULL=0; PP_FULL_REASON=""; PP_BASE=""
  _pp_seen=$'\n'

  _pp_key_for "$PP_ROOT"

  if [ "${CI_FULL:-0}" = "1" ] || [ "${PP_FORCE_FULL:-0}" = "1" ]; then
    PP_FULL=1; PP_FULL_REASON="CI_FULL=1 / --full / non-gate tier"
  fi

  local g head="" resolved=0 remote_base="" cand lsha rsha base up out
  # one call: head sha, tree sha, common dir
  g="$(git -C "$PP_ROOT" rev-parse HEAD 'HEAD^{tree}' --path-format=absolute --git-common-dir 2>/dev/null || true)"
  # (|| true on each: a non-repo directory yields no lines, and `read` at EOF
  # fails -- fatal under the callers' `set -e`.)
  { read -r head || true; read -r PP_TREE || true; read -r PP_COMMON || true; } <<EOF
$g
EOF

  # first existing default remote ref (one call)
  out="$(git -C "$PP_ROOT" for-each-ref --format='%(refname:short)' refs/remotes/origin/development refs/remotes/origin/main refs/remotes/origin/master 2>/dev/null || true)"
  for cand in origin/development origin/main origin/master; do
    case $'\n'"$out"$'\n' in *$'\n'"$cand"$'\n'*) remote_base="$cand"; break ;; esac
  done

  if [ -n "$refs" ]; then
    while IFS=' ' read -r _ lsha _ rsha; do
      [ -n "${lsha:-}" ] || continue
      if [[ "$lsha" =~ $_pp_zero_re ]]; then continue; fi          # branch delete
      base=""
      if [ -n "${rsha:-}" ] && ! [[ "$rsha" =~ $_pp_zero_re ]]; then
        base="$(git -C "$PP_ROOT" merge-base "$rsha" "$lsha" 2>/dev/null || true)"
      fi
      if [ -z "$base" ] && [ -n "$remote_base" ]; then
        base="$(git -C "$PP_ROOT" merge-base "$remote_base" "$lsha" 2>/dev/null || true)"
      fi
      if [ -z "$base" ]; then
        PP_FULL=1; PP_FULL_REASON="${PP_FULL_REASON:-no base for pushed ref $lsha}"
        continue
      fi
      PP_BASE="$base"
      _pp_add_files "$(git -C "$PP_ROOT" -c core.quotepath=off diff --name-status --no-renames "$base" "$lsha" -- 2>/dev/null || true)"
      resolved=1
    done <<EOF
$refs
EOF
    if [ "$resolved" -eq 1 ]; then
      # uncommitted edits to tracked files: the gate checks the files on disk
      _pp_add_files "$(git -C "$PP_ROOT" -c core.quotepath=off diff --name-status --no-renames HEAD -- 2>/dev/null || true)"
    fi
  fi

  if [ "$resolved" -eq 0 ]; then
    up="$(git -C "$PP_ROOT" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || true)"
    base=""
    if [ -n "$up" ]; then
      base="$(git -C "$PP_ROOT" merge-base HEAD "$up" 2>/dev/null || true)"
    fi
    if [ -z "$base" ] && [ -n "$remote_base" ]; then
      base="$(git -C "$PP_ROOT" merge-base HEAD "$remote_base" 2>/dev/null || true)"
    fi
    if [ -n "$base" ]; then
      PP_BASE="$base"
      # base..working tree: committed range AND uncommitted tracked edits, one call
      _pp_add_files "$(git -C "$PP_ROOT" -c core.quotepath=off diff --name-status --no-renames "$base" -- 2>/dev/null || true)"
      resolved=1
    fi
  fi

  if [ "$resolved" -eq 0 ]; then
    PP_FULL=1
    PP_FULL_REASON="${PP_FULL_REASON:-no push range resolvable (no upstream, no origin/<default>)}"
  fi

  # Shared inputs: a change here can alter the verdict of every check.
  if [ "$PP_FULL" -eq 0 ] && [ -n "${PP_FULL_RE:-}" ]; then
    local f
    for f in "${PP_FILES[@]}"; do
      if [[ "$f" =~ $PP_FULL_RE ]]; then
        PP_FULL=1; PP_FULL_REASON="gate/shared input changed: $f"
        break
      fi
    done
  fi
  return 0
}

pp_is_full() { [ "$PP_FULL" -eq 1 ]; }

# pp_any <ere> [exclude-ere] -> success when any changed path matches
pp_any() {
  local f re="$1" ex="${2:-}"
  for f in "${PP_FILES[@]}"; do
    [[ "$f" =~ $re ]] || continue
    if [ -n "$ex" ] && [[ "$f" =~ $ex ]]; then continue; fi
    return 0
  done
  return 1
}

# pp_graph_changed <path-ere> -> success when the import graph of matching files
# may have changed: a matching file was ADDED or DELETED, or a modified one has a
# changed line mentioning import/export/require/from. (knip and dependency-cruiser
# only look at the graph, so a body-only edit cannot change their verdict.)
# Unknown base => assume changed.
_pp_gm_re=""
_pp_gm_rc=1
pp_graph_changed() { # memoised per regex: the preflight and the step both ask
  if [ "$1" = "$_pp_gm_re" ]; then return "$_pp_gm_rc"; fi
  local rc=0
  _pp_graph_changed_raw "$1" || rc=$?
  _pp_gm_re="$1"; _pp_gm_rc=$rc
  return "$rc"
}
_pp_graph_changed_raw() {
  local f re="$1" mods=() d line
  for f in "${PP_ADDDEL[@]}"; do
    if [[ "$f" =~ $re ]]; then return 0; fi
  done
  for f in "${PP_FILES[@]}"; do
    if [[ "$f" =~ $re ]] && [ -e "$PP_ROOT/$f" ]; then mods+=("$f"); fi
  done
  [ "${#mods[@]}" -gt 0 ] || return 1
  [ -n "$PP_BASE" ] || return 0
  d="$(git -C "$PP_ROOT" diff -U0 --no-color "$PP_BASE" -- "${mods[@]}" 2>/dev/null || echo '+import unknown')"
  while IFS= read -r line; do
    case "$line" in
      '+++'*|'---'*) continue ;;
      '+'*|'-'*) if [[ "$line" =~ (import|export|require|from[[:space:]]) ]]; then return 0; fi ;;
    esac
  done <<EOF
$d
EOF
  return 1
}

# pp_want_graph <id> <path-ere>  (like pp_want, but graph-sensitive)
pp_want_graph() {
  if pp_is_full; then pp_ran "$1" "full tier"; return 0; fi
  if pp_graph_changed "$2"; then pp_ran "$1" "import graph may have changed"; return 0; fi
  pp_skip "$1" "no file added/deleted and no import/export line changed"
  return 1
}

# pp_list_existing / pp_list_deleted <ere> [exclude-ere] -> PP_M (array)
pp_list_existing() {
  local f re="$1" ex="${2:-}"
  PP_M=()
  for f in "${PP_FILES[@]}"; do
    [[ "$f" =~ $re ]] || continue
    if [ -n "$ex" ] && [[ "$f" =~ $ex ]]; then continue; fi
    if [ -e "$PP_ROOT/$f" ]; then PP_M+=("$f"); fi
  done
}
pp_list_deleted() {
  local f re="$1" ex="${2:-}"
  PP_M=()
  for f in "${PP_FILES[@]}"; do
    [[ "$f" =~ $re ]] || continue
    if [ -n "$ex" ] && [[ "$f" =~ $ex ]]; then continue; fi
    if [ ! -e "$PP_ROOT/$f" ]; then PP_M+=("$f"); fi
  done
}

# pp_want <id> <ere> [exclude-ere]
#   Records the decision. Returns 0 (run) when FULL or a changed path matches.
pp_want() {
  if pp_is_full; then pp_ran "$1" "full tier"; return 0; fi
  if pp_any "$2" "${3:-}"; then pp_ran "$1" "changed paths match"; return 0; fi
  pp_skip "$1" "no matching paths changed"
  return 1
}

# Steps matching this never take a gate slot (cheap, and a docs-only push must
# not queue behind someone's build).
PP_LIGHT_RE='^(gitleaks|user-data-size|migration-duplicates|docs-drift|supply-chain|workflow-triggers|orphan-tables)$'

# Callers that decide scope themselves (per-workspace helpers) use these.
pp_ran() {
  local line
  printf -v line 'ran     %-34s %s' "$1" "${2:-}"
  PP_SUMMARY+=("$line")
  if ! [[ "$1" =~ $PP_LIGHT_RE ]]; then pp_heavy_begin; fi
}
pp_skip() {
  local line
  printf -v line 'skipped %-34s %s' "$1" "${2:-}"
  PP_SUMMARY+=("$line")
  printf '  - skipped %s (%s)\n' "$1" "${2:-}"
}

pp_summary() {
  local line full=""
  if pp_is_full; then full=" -- FULL ($PP_FULL_REASON)"; fi
  echo ""
  echo "=== gate summary: ${#PP_FILES[@]} changed path(s) vs ${PP_BASE:-<no base>}$full ==="
  for line in "${PP_SUMMARY[@]}"; do printf '%s\n' "$line"; done
}

pp_cleanup() {
  pp_unlock
  pp_heavy_end
  return 0
}

# ---------------------------------------------------------------------------
# Caches: per checkout, under the (possibly junction-shared) node_modules/.cache
# so they are gitignored, but keyed by checkout so two worktrees never write
# the same cache file (a worktree's node_modules is a junction to the MAIN
# checkout's, so anything stored under it is shared unless keyed like this).
# ---------------------------------------------------------------------------
pp_cache_dir() { # pp_cache_dir <name> -> $PP_CACHE
  PP_CACHE="$PP_ROOT/node_modules/.cache/prepush/$PP_KEY/$1"
  mkdir -p "$PP_CACHE" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Lock: serialises two gate runs in the SAME checkout (e.g. wt-land's gate and
# a hook fired by the push that follows). mkdir is atomic; Git Bash has no
# reliable flock. Stale locks (older than PP_LOCK_TTL seconds) are broken.
# ---------------------------------------------------------------------------
PP_LOCK_DIR=""
PP_LOCK_HELD=0

pp_lock() {
  local name="${1:-gate}" wait="${PP_LOCK_WAIT:-600}" ttl="${PP_LOCK_TTL:-1800}" waited=0 now mt owner
  [ -n "$PP_COMMON" ] || return 0
  mkdir -p "$PP_COMMON/ci-gate-locks" 2>/dev/null || return 0
  PP_LOCK_DIR="$PP_COMMON/ci-gate-locks/$PP_KEY-$name.lock"
  while ! mkdir "$PP_LOCK_DIR" 2>/dev/null; do
    # owner dead (a killed gate never ran its EXIT trap) => stale at once
    owner=""
    if [ -f "$PP_LOCK_DIR/pid" ]; then read -r owner <"$PP_LOCK_DIR/pid" 2>/dev/null || true; fi
    if [ -n "$owner" ] && ! _pp_pid_alive "$owner"; then
      echo "prepush: breaking lock $PP_LOCK_DIR (owner pid $owner is gone)" >&2
      rm -rf "$PP_LOCK_DIR" 2>/dev/null
      continue
    fi
    _pp_now now
    mt="$(stat -c %Y "$PP_LOCK_DIR" 2>/dev/null || echo "$now")"
    if [ $((now - mt)) -gt "$ttl" ]; then
      echo "prepush: breaking stale lock $PP_LOCK_DIR" >&2
      rm -rf "$PP_LOCK_DIR" 2>/dev/null
      continue
    fi
    if [ "$waited" -ge "$wait" ]; then
      echo "prepush: could not take $PP_LOCK_DIR within ${wait}s (another gate in this checkout?)" >&2
      PP_LOCK_DIR=""
      return 1
    fi
    if [ "$waited" -eq 0 ]; then echo "prepush: another gate run holds the lock for this checkout, waiting..." >&2; fi
    sleep 3; waited=$((waited + 3))
  done
  printf '%s\n' "$$" >"$PP_LOCK_DIR/pid"
  PP_LOCK_HELD=1
}

pp_unlock() {
  if [ "$PP_LOCK_HELD" -eq 1 ] && [ -n "$PP_LOCK_DIR" ]; then
    rm -rf "$PP_LOCK_DIR" 2>/dev/null
    PP_LOCK_HELD=0
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Machine-wide gate slots (a counting semaphore shared by EVERY gate on the
# machine -- all worktrees, all repos). Ten gates running at once made each
# one 10-40x slower (deploy.test.sh: ~90 s alone, over an hour under load), so
# the heavy part of a gate takes one of N slots (default 2) and the rest queue.
#
#   MAPLE_GATE_SLOTS=N       slots (default 2; 0 disables the limiter)
#   MAPLE_GATE_SLOT_DIR=...  default %LOCALAPPDATA%/maple-gate-slots (else
#                            ~/.cache/maple-gate-slots) -- OUTSIDE any worktree
#   MAPLE_GATE_SLOT_WAIT=s   give up queuing after s seconds and run anyway
#                            (default 5400; it is a politeness limiter, never a
#                            reason to fail or skip a check)
#
# Protocol: slot-<i>/ directories taken with atomic mkdir, each holding
# "<pid> <epoch>"; FIFO tickets in queue/ (<epoch>-<pid>) decide who may try
# next. A slot or ticket whose pid is dead is stale and reclaimed immediately
# (kill -0; MSYS pids are visible across Git Bash processes). A 4 h age cap
# covers pid reuse.
#
# Only the heavy steps queue: pp_ran calls pp_heavy_begin for every step not
# matching PP_LIGHT_RE, so a docs-only push never waits. The slot is held until
# the gate exits (pp_cleanup).
# ---------------------------------------------------------------------------
PP_SLOT_HELD=""
PP_TICKET=""
PP_SLOT_ROOT=""

_pp_slot_root() { # -> $PP_SLOT_ROOT
  if [ -n "${MAPLE_GATE_SLOT_DIR:-}" ]; then
    PP_SLOT_ROOT="$MAPLE_GATE_SLOT_DIR"
  elif [ -n "${LOCALAPPDATA:-}" ]; then
    PP_SLOT_ROOT="$(cygpath -u "$LOCALAPPDATA" 2>/dev/null || printf '%s' "$LOCALAPPDATA")/maple-gate-slots"
  else
    PP_SLOT_ROOT="${HOME:-/tmp}/.cache/maple-gate-slots"
  fi
}

_pp_pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }

_pp_slot_reap() { # remove stale slots + tickets
  local root="$1" d t pid epoch now name mt
  _pp_now now
  for d in "$root"/slot-*; do
    [ -d "$d" ] || continue
    pid=""; epoch=""
    if [ -f "$d/pid" ]; then read -r pid epoch <"$d/pid" 2>/dev/null || true; fi
    if [ -z "$pid" ]; then
      # no pid file: its owner is between mkdir and write (or died there).
      # Rare, so one stat is fine: reap when older than a minute.
      mt="$(stat -c %Y "$d" 2>/dev/null || echo "$now")"
      if [ $((now - mt)) -gt 60 ]; then rm -rf "$d" 2>/dev/null; fi
      continue
    fi
    if ! _pp_pid_alive "$pid" || [ $((now - ${epoch:-$now})) -gt 14400 ]; then rm -rf "$d" 2>/dev/null; fi
  done
  for t in "$root"/queue/*; do
    [ -f "$t" ] || continue
    name="${t##*/}"; epoch="${name%%-*}"; pid="${name##*-}"; pid=$((10#${pid:-0}))
    if ! _pp_pid_alive "$pid" || [ $((now - 10#${epoch:-$now})) -gt 14400 ]; then rm -f "$t" 2>/dev/null; fi
  done
  return 0
}

pp_heavy_begin() {
  [ -n "$PP_SLOT_HELD" ] && return 0
  local n="${MAPLE_GATE_SLOTS:-2}" wait="${MAPLE_GATE_SLOT_WAIT:-5400}" waited=0 last_msg=-60 root now i busy ahead t k
  [ "$n" -gt 0 ] 2>/dev/null || return 0
  _pp_slot_root; root="$PP_SLOT_ROOT"
  mkdir -p "$root/queue" 2>/dev/null || { echo "prepush: cannot create $root, running without a gate slot" >&2; return 0; }
  _pp_now now
  printf -v PP_TICKET '%s/queue/%s-%07d' "$root" "$now" "$$"
  : >"$PP_TICKET"
  while :; do
    _pp_slot_reap "$root"
    busy=0; ahead=0
    for t in "$root"/queue/*; do
      [ -f "$t" ] || continue
      if [[ "$t" < "$PP_TICKET" ]]; then ahead=$((ahead + 1)); fi
    done
    for ((i = 1; i <= n; i++)); do if [ -d "$root/slot-$i" ]; then busy=$((busy + 1)); fi; done
    # FIFO: only try when my turn is within the free slots.
    if [ "$ahead" -lt $((n - busy)) ]; then
      for ((i = 1; i <= n; i++)); do
        if mkdir "$root/slot-$i" 2>/dev/null; then
          _pp_now now
          printf '%s %s\n' "$$" "$now" >"$root/slot-$i/pid"
          PP_SLOT_HELD="$root/slot-$i"
          rm -f "$PP_TICKET" 2>/dev/null; PP_TICKET=""
          if [ "$waited" -gt 0 ]; then echo "prepush: got gate slot $i/$n after ${waited}s"; fi
          return 0
        fi
      done
    fi
    if [ "$waited" -ge "$wait" ]; then
      echo "prepush: no gate slot after ${waited}s - running anyway (limiter is advisory)" >&2
      rm -f "$PP_TICKET" 2>/dev/null; PP_TICKET=""
      return 0
    fi
    if [ $((waited - last_msg)) -ge 60 ]; then
      k=$((busy + ahead - n + 1)); if [ "$k" -lt 1 ]; then k=1; fi
      echo "prepush: waiting for gate slot ($k ahead; $busy/$n slots busy)"
      last_msg=$waited
    fi
    sleep 3; waited=$((waited + 3))
  done
}

pp_heavy_end() {
  if [ -n "$PP_SLOT_HELD" ]; then rm -rf "$PP_SLOT_HELD" 2>/dev/null; PP_SLOT_HELD=""; fi
  if [ -n "$PP_TICKET" ]; then rm -f "$PP_TICKET" 2>/dev/null; PP_TICKET=""; fi
  return 0
}

# ---------------------------------------------------------------------------
# Pass stamp, bound to the TREE sha (not the commit sha: wt-land rebases and
# fast-forwards, commit shas move, the tree does not). Lives in the git common
# dir so every worktree and the hook see it; never in the working tree.
#
# Reuse rule (pp_stamp_covers): same tree sha AND a clean tracked tree AND
#   - the stamp is a FULL pass, or
#   - every path in the current changed set was in the stamped changed set.
# It can never satisfy a different tree sha.
# ---------------------------------------------------------------------------
_pp_tree_clean() { # one git call
  local s
  s="$(git -C "$PP_ROOT" status --porcelain --untracked-files=no 2>/dev/null || echo dirty)"
  [ -z "$s" ]
}

_pp_stamp_path() { # <tier> -> $PP_STAMP
  PP_STAMP=""
  [ -n "$PP_COMMON" ] && [ -n "$PP_TREE" ] || return 1
  PP_STAMP="$PP_COMMON/ci-gate-pass/$1-$PP_TREE"
}

# pp_stamp_write <tier>
pp_stamp_write() {
  local tier="$1" tmp f stamp_at
  _pp_tree_clean || { echo "prepush: tree has uncommitted changes, no pass stamp written" >&2; return 0; }
  _pp_stamp_path "$tier" || return 0
  mkdir -p "$PP_COMMON/ci-gate-pass" 2>/dev/null || return 0
  tmp="$PP_STAMP.$$.tmp"
  _pp_now stamp_at
  {
    printf 'at %s\n' "$stamp_at"
    if pp_is_full; then printf 'mode full\n'; else printf 'mode affected\n'; fi
    for f in "${PP_FILES[@]}"; do printf 'file %s\n' "$f"; done
  } >"$tmp" && mv -f "$tmp" "$PP_STAMP"
  # Housekeeping: stamps older than 14 days.
  find "$PP_COMMON/ci-gate-pass" -type f -mtime +14 -delete 2>/dev/null || true
}

# pp_stamp_covers <tier>  -> success when a stamp makes this run redundant
pp_stamp_covers() {
  local tier="$1" content f
  [ "${PP_NO_STAMP:-0}" = "1" ] && return 1
  [ "${CI_FULL:-0}" = "1" ] && return 1
  _pp_stamp_path "$tier" || return 1
  [ -f "$PP_STAMP" ] || return 1
  _pp_tree_clean || return 1
  IFS= read -r -d '' content <"$PP_STAMP" || true
  content=$'\n'"$content"
  case "$content" in *$'\n'"mode full"$'\n'*) return 0 ;; esac
  pp_is_full && return 1   # a full run is only satisfied by a full pass
  for f in "${PP_FILES[@]}"; do
    case "$content" in *$'\n'"file $f"$'\n'*) ;; *) return 1 ;; esac
  done
  return 0
}
