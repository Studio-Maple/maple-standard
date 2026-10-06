#!/usr/bin/env bash
# plugin/scripts/prepush/landing-lock.integration.test.sh -- concurrency-proof pushing (prepush-lib pp_land_*):
#   * staleness: a pushed commit that does not contain the remote tip is refused at
#     once, with the "<branch> moved to <sha> (<subject>, by <author>) - rebase" message
#   * the per-target-ref landing lock: holder record, a second pusher WAITS and is told
#     who holds it / since when / what they push, timeout exits with the same info
#   * a dead holder pid is reclaimed, the same holder id re-enters, failure releases
#   * two REAL concurrent `git push`es to one ref from two worktrees: one gates while
#     the other waits, then is told to rebase because the first landed
# Hermetic: throwaway repos + a local bare remote, no network.
set -uo pipefail

# A hook exports GIT_DIR & co. to everything it runs; when this test runs from the
# gate inside a pre-push hook they would point every `git init`/`git config` below
# at the REAL repository (it corrupted core.bare/user/branches once). Hermetic:
for v in $(git rev-parse --local-env-vars 2>/dev/null); do unset "$v"; done
LIB="${PREPUSH_LIB:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prepush-lib.sh}"
FAILURES=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { FAILURES=$((FAILURES + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

unset CI_FULL PP_FORCE_FULL PP_NO_STAMP PP_FULL_RE CI_PREPUSH MAPLE_LAND_WAIT MAPLE_LAND_REFS_RE MAPLE_LAND_REMOTE PP_LAND_HOLDER_ID PP_OWNER_OVERRIDE
export GIT_AUTHOR_NAME=Alice GIT_AUTHOR_EMAIL=a@t GIT_COMMITTER_NAME=Alice GIT_COMMITTER_EMAIL=a@t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

W="$(mktemp -d 2>/dev/null || mktemp -d -t landlock)"
trap 'rm -rf "$W"' EXIT

# --- hermetic: never reach the real repository or a real remote ---------------
# (When this runs inside a real pre-push hook, git's hook environment points every
# git command at the REAL repo: an earlier version re-initialised it, set
# core.bare=true, added a remote and pushed the real HEAD.)
for v in GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX GIT_NAMESPACE GIT_QUARANTINE_PATH $(git rev-parse --local-env-vars 2>/dev/null); do unset "$v"; done
unset PP_SLOT_INHERITED
export GIT_ALLOW_PROTOCOL=file GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1
# must_be_temp <dir>: abort unless <dir> is its OWN git repo inside this test's temp area
must_be_temp() {
  local g wn gn
  g="$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null || true)"
  # compare in one path syntax (MSYS /tmp/... vs C:/Users/...), case-insensitively
  gn="$(cd "$g" 2>/dev/null && { pwd -W 2>/dev/null || pwd; } || printf '%s' "$g")"; gn="${gn,,}"
  wn="$(cd "$W" && { pwd -W 2>/dev/null || pwd; })"; wn="${wn,,}"
  case "$gn" in "$wn"/*) ;; *) echo "ABORT: $1 resolves to git dir '$g', outside the test temp area '$W'" >&2; exit 99 ;; esac
}
git init -q --bare "$W/remote.git"
git init -q -b development "$W/main"
cd "$W/main" || exit 1
must_be_temp "$W/main"
git config user.email a@t; git config user.name Alice
echo base > f; git add f; git commit -q -m base
git remote add origin "$W/remote.git"
git push -q origin development 2>/dev/null

# run a snippet with the lib sourced and set -euo pipefail (like the gate scripts)
run() { bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; '"$1" "$LIB"; }

echo "staleness (fail fast)"
# the remote moves on: someone else lands X
git clone -q -b development "$W/remote.git" "$W/other" 2>/dev/null
must_be_temp "$W/other"
( cd "$W/other" && git config user.name Bob && git config user.email b@t && echo x > x && git add x && GIT_AUTHOR_NAME=Bob git commit -q -m "bob's change" && git push -q origin development 2>/dev/null )
TIP="$(git -C "$W/other" rev-parse HEAD)"
git checkout -q -b mine; echo y > y; git add y; git commit -q -m mine; MINE="$(git rev-parse HEAD)"
out="$(run "pp_land_fresh_check origin refs/heads/development $MINE" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "a commit that lacks the remote tip is refused (exit $rc)"; else fail "stale is refused" "$out"; fi
if echo "$out" | grep -q "development moved to ${TIP:0:10} (bob's change, by Bob)"; then pass "...naming the new tip, its subject and author"; else fail "message names tip/subject/author" "$out"; fi
if echo "$out" | grep -q "rebase onto it and push again"; then pass "...and says what to do"; else fail "message says rebase" "$out"; fi
git rebase -q origin/development 2>/dev/null || git rebase -q "$TIP"
git fetch -q origin development; git rebase -q FETCH_HEAD; MINE="$(git rev-parse HEAD)"
out="$(run "pp_land_fresh_check origin refs/heads/development $MINE" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then pass "after rebasing onto the tip the check passes"; else fail "fresh passes" "$out"; fi
out="$(run "pp_land_fresh_check origin refs/heads/development $TIP" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ]; then pass "pushing exactly the remote tip is fresh"; else fail "tip itself fresh" "$out"; fi

echo "landing lock"
LOCKDIR="$(git rev-parse --path-format=absolute --git-common-dir)/landing-locks"
export CLAUDE_SESSION_NAME="session-one"
out="$(run "PP_OWNER_OVERRIDE=msys:$$ pp_land_acquire origin refs/heads/development $MINE 5 msys:$$; cat \"$LOCKDIR\"/origin--development.lock/holder" 2>&1)"
if echo "$out" | grep -q "^session=session-one" && echo "$out" | grep -q "^sha=$MINE" && echo "$out" | grep -q "^branch=mine" && echo "$out" | grep -q "^pid=$$"; then pass "the holder record names session, branch, worktree, pid and sha"; else fail "holder record" "$out"; fi
# the subshell that took it has exited but the recorded owner ($$ = this test) is alive: the lock stays
if [ -d "$LOCKDIR/origin--development.lock" ]; then pass "the lock outlives the acquiring shell while its owner pid lives"; else fail "lock persists" ""; fi
export CLAUDE_SESSION_NAME="session-two"
out="$(run "pp_land_acquire origin refs/heads/development $TIP 3 msys:$$" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ]; then pass "a second pusher waits, then gives up at the timeout (exit $rc)"; else fail "second waits then times out" "$out"; fi
if echo "$out" | grep -q "waiting for landing lock on development: held by session-one \[branch mine"; then pass "...printing who holds it"; else fail "waiting message: holder" "$out"; fi
if echo "$out" | grep -qE "since [0-9:]+ \(pushing ${MINE:0:10}\)"; then pass "...since when, and what they are pushing"; else fail "waiting message: since/sha" "$out"; fi
if echo "$out" | grep -q "gave up after" && echo "$out" | grep -q "held by session-one"; then pass "the timeout exit carries the same holder info"; else fail "timeout message" "$out"; fi

echo "stale holder / re-entry / release"
rm -rf "$LOCKDIR"/origin--development.lock; mkdir -p "$LOCKDIR/origin--development.lock"
printf 'id=dead-1\npid=999999\nkind=msys\nepoch=%s\nsha=%s\nbranch=old\nworktree=/x\nsession=ghost\n' "$(date +%s)" "$MINE" > "$LOCKDIR/origin--development.lock/holder"
out="$(run "pp_land_acquire origin refs/heads/development $MINE 10 msys:$$" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && echo "$out" | grep -q "reclaiming the landing lock on development (holder pid 999999 is gone)"; then pass "a dead holder pid releases the lock automatically"; else fail "stale reclaim" "rc=$rc $out"; fi
rm -rf "$LOCKDIR"/origin--development.lock
out="$(run "pp_land_acquire origin refs/heads/development $MINE 5 msys:$$; PP_LAND_HOLDER_ID=\$PP_LAND_HOLDER_ID pp_land_acquire origin refs/heads/development $MINE 2 msys:$$ && echo REENTERED" 2>&1)"
if echo "$out" | grep -q REENTERED; then pass "the same holder id re-enters without waiting (wt-land, then the hook of its push)"; else fail "re-entry" "$out"; fi
rm -rf "$LOCKDIR"/origin--development.lock
out="$(run "pp_land_acquire origin refs/heads/development $MINE 5 msys:$$ && pp_land_release_all && test ! -d \"$LOCKDIR/origin--development.lock\" && echo RELEASED" 2>&1)"
if echo "$out" | grep -q RELEASED; then pass "a failing gate releases the lock at once"; else fail "release on failure" "$out"; fi
rm -rf "$LOCKDIR"/origin--development.lock

echo "non-landing refs are not locked"
out="$(run "PP_REFS_TEXT='refs/heads/feat $MINE refs/heads/feat 0000000000000000000000000000000000000000'; pp_land_hook_begin origin && ls \"$LOCKDIR\" 2>/dev/null | wc -l" 2>&1 | tail -1)"
if [ "$out" = "0" ]; then pass "pushing a feature branch takes no landing lock"; else fail "feature branch unlocked" "$out"; fi

echo "two concurrent real pushes to one ref"
HOOKS="$W/hooks"; mkdir -p "$HOOKS"
cat > "$HOOKS/pre-push" <<EOF
#!/bin/sh
refs="\$(cat)"
. "$LIB"
pp_init "\$PWD" "\$refs"
pp_land_hook_begin "\$1" || { pp_land_release_all; exit 1; }
echo "GATE-START \$(basename "\$PWD")"
sleep "\${GATE_SLEEP:-0}"
pp_land_hook_end || { pp_land_release_all; exit 1; }
echo "GATE-OK \$(basename "\$PWD")"
EOF
chmod +x "$HOOKS/pre-push"
git config core.hooksPath "$HOOKS"
git checkout -q development; git fetch -q origin development; git reset -q --hard FETCH_HEAD
git worktree add -q "$W/wtA" -b featA 2>/dev/null; git worktree add -q "$W/wtB" -b featB 2>/dev/null
( cd "$W/wtA" && echo a > a && git add a && git commit -q -m "A lands first" )
( cd "$W/wtB" && echo b > b && git add b && git commit -q -m "B is second" )
A_SHA="$(git -C "$W/wtA" rev-parse HEAD)"
export MAPLE_LAND_WAIT=120
( cd "$W/wtA" && CLAUDE_SESSION_NAME=session-A GATE_SLEEP=8 git push origin HEAD:development > "$W/A.out" 2>&1; echo "rc=$?" >> "$W/A.out" ) &
PA=$!
sleep 4
( cd "$W/wtB" && CLAUDE_SESSION_NAME=session-B GATE_SLEEP=0 git push origin HEAD:development > "$W/B.out" 2>&1; echo "rc=$?" >> "$W/B.out" ) &
PB=$!
wait "$PA" "$PB"
if grep -q "rc=0" "$W/A.out"; then pass "the first pusher gated and landed"; else fail "A landed" "$(cat "$W/A.out")"; fi
if grep -q "waiting for landing lock on development: held by session-A" "$W/B.out"; then pass "the second pusher WAITED, told who holds the lock"; else fail "B waited" "$(cat "$W/B.out")"; fi
if ! grep -q "GATE-START wtB" "$W/B.out"; then pass "...and never started its gate"; else fail "B skipped its gate" "$(cat "$W/B.out")"; fi
if grep -q "got the landing lock on development" "$W/B.out" && grep -q "development moved to ${A_SHA:0:10} (A lands first" "$W/B.out"; then pass "...then, on getting the lock, was told to rebase because A landed"; else fail "B told to rebase" "$(cat "$W/B.out")"; fi
if grep -q "rc=1" "$W/B.out"; then pass "the second push was refused (exit 1)"; else fail "B refused" "$(cat "$W/B.out")"; fi
if [ "$(git -C "$W/remote.git" rev-parse development)" = "$A_SHA" ]; then pass "the remote tip is the first pusher's commit"; else fail "remote tip" ""; fi
if [ ! -d "$LOCKDIR/origin--development.lock" ]; then pass "no landing lock is left behind after both pushes ended"; else fail "lock cleaned up" "$(cat "$LOCKDIR"/origin--development.lock/holder 2>/dev/null)"; fi

echo ""
printf 'landing-lock self-test: %s failure(s)\n' "$FAILURES"
[ "$FAILURES" -eq 0 ]
