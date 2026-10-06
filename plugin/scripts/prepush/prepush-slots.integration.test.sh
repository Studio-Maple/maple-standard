#!/usr/bin/env bash
# plugin/scripts/prepush/prepush-slots.integration.test.sh
#
# The machine-wide gate-slot semaphore + the per-checkout gate lock of prepush-lib.sh, with real waiting holder
# processes (tens of seconds of genuine sleeping, hence the integration set - heavy tier only; the selection / stamp /
# lock / sleep-fallback proofs stay in prepush-lib.test.sh). Hermetic: throwaway repo, private slot dir, no network.
#
# Run directly: bash plugin/scripts/prepush/prepush-slots.integration.test.sh

set -uo pipefail

# A hook exports GIT_DIR & co. to everything it runs; when this test runs from the
# gate inside a pre-push hook they would point every `git init`/`git config` below
# at the REAL repository (it corrupted core.bare/user/branches once). Hermetic:
for v in $(git rev-parse --local-env-vars 2>/dev/null); do unset "$v"; done

# This file is run from inside the gate itself (full tier), which exports CI_FULL
# etc.; the cases below assume a clean slate.
unset CI_FULL PP_FORCE_FULL PP_NO_STAMP PP_FULL_RE CI_PREPUSH CI_LOCAL_SELFTEST MAPLE_GATE_SLOTS MAPLE_GATE_SLOT_DIR MAPLE_GATE_SLOT_WAIT PP_LOCK_WAIT PP_LOCK_GRACE

LIB="${PREPUSH_LIB:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prepush-lib.sh}"

FAILURES=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { FAILURES=$((FAILURES + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }
check() { # check <name> <expected-exit> <command...>
  local name="$1" want="$2"; shift 2
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [ "$rc" -eq "$want" ]; then pass "$name"; else fail "$name" "exit $rc, wanted $want: $out"; fi
}

W="$(mktemp -d 2>/dev/null || mktemp -d -t ppaff)"
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
# Never touch (or queue behind) the REAL machine-wide gate slots: when this test runs
# inside a gate it would wait for a slot behind other sessions' gates (it once sat
# 25 minutes). The slot cases below set their own MAPLE_GATE_SLOT_DIR explicitly.
export MAPLE_GATE_SLOT_DIR="$W/slots-isolated"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

git init -q --bare "$W/origin.git"
git init -q -b development "$W/repo"
cd "$W/repo" || exit 1
must_be_temp "$W/repo"
git config user.email t@t; git config user.name t
mkdir -p app/src admin/src docs scripts/lib
echo a > app/src/a.ts; echo b > admin/src/b.ts; echo d > docs/d.md
echo '#!/bin/sh' > scripts/ci-local.sh; echo '{}' > package-lock.json
git add -A; git commit -q -m base
git remote add origin "$W/origin.git"; git push -q origin development 2>/dev/null
git branch -q --set-upstream-to=origin/development development
git fetch -q origin 2>/dev/null

# helper: run a snippet with the lib sourced in a fresh shell, rooted at $PWD
FULL_RE='^scripts/ci-local\.sh$|(^|/)package-lock\.json$|(^|/)tsconfig[^/]*\.json$'
# `set -euo pipefail` like the gate scripts it is sourced into: a builtin that fails
# at EOF or on an empty array must not be able to kill a gate.
run() { PP_FULL_RE="$FULL_RE" bash -c 'set -euo pipefail; . "$0"; '"$1" "$LIB"; }

echo "machine-wide gate slots"
# a gate NESTED in a slot holder must not queue for a second slot (deadlock): it inherits
out="$(MAPLE_GATE_SLOT_DIR="$W/slots-nest" MAPLE_GATE_SLOTS=1 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_heavy_begin; MAPLE_GATE_SLOT_WAIT=2 bash -c "set -euo pipefail; . \"\$0\"; pp_init \"\$PWD\"; pp_ran nested-step x; echo NESTED_RAN" "$0"' "$LIB" 2>&1)"
if echo "$out" | grep -q '^NESTED_RAN$' && ! echo "$out" | grep -q waiting; then pass "a nested gate inherits its parent's slot instead of deadlocking on a second one"; else fail "nested slot inheritance" "$out"; fi
SLOTS="$W/slots"
holder() { # holder <n> -> background process that holds a slot for ~25s
  MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS="$1" bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_heavy_begin; sleep 25' "$LIB" >/dev/null 2>&1 &
  HOLD_PIDS="${HOLD_PIDS:-} $!"
}
wait_busy() { # wait_busy <count>
  local i=0 n d
  while [ "$i" -lt 60 ]; do
    n=0
    for d in "$SLOTS"/slot-*; do if [ -d "$d" ]; then n=$((n + 1)); fi; done
    if [ "$n" -ge "$1" ]; then return 0; fi
    sleep 0.5; i=$((i + 1))
  done
}
holder 1; wait_busy 1
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=1 MAPLE_GATE_SLOT_WAIT=4 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_ran app-test x; echo AFTER' "$LIB" 2>&1)"
if echo "$out" | grep -q 'waiting for gate slot (1 ahead'; then pass "a second heavy gate with N=1 prints 'waiting for gate slot (k ahead)'"; else fail "waiting message" "$out"; fi
if echo "$out" | grep -q 'running anyway' && echo "$out" | grep -q '^AFTER$'; then pass "the limiter is advisory: it runs after the wait cap instead of failing"; else fail "wait cap" "$out"; fi
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=1 MAPLE_GATE_SLOT_WAIT=2 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_ran gitleaks x; pp_ran docs-drift x; echo AFTER' "$LIB" 2>&1)"
if [ "$out" = "AFTER" ]; then pass "light steps (gitleaks, docs-drift) never queue for a slot"; else fail "light steps" "$out"; fi
for hp in $HOLD_PIDS; do kill "$hp" 2>/dev/null; done; wait 2>/dev/null; HOLD_PIDS=""
# killed holders leave their slot dir behind: the dead pid must free it at once
if [ -d "$SLOTS/slot-1" ]; then pass "(setup) the killed holder left a stale slot behind"; else pass "(setup) holder cleaned up"; fi
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=1 MAPLE_GATE_SLOT_WAIT=6 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_heavy_begin; echo GOT' "$LIB" 2>&1)"
if echo "$out" | grep -q '^GOT$' && ! echo "$out" | grep -q 'waiting'; then pass "a dead PID releases its slot immediately (stale-safe)"; else fail "stale slot" "$out"; fi
rm -rf "$SLOTS"; mkdir -p "$SLOTS/slot-1"; echo 999999 > "$SLOTS/slot-1/pid"
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=1 MAPLE_GATE_SLOT_WAIT=6 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_heavy_begin; echo GOT' "$LIB" 2>&1)"
if echo "$out" | grep -q '^GOT$' && ! echo "$out" | grep -q 'waiting'; then pass "a slot owned by a nonexistent PID is reclaimed"; else fail "dead pid slot" "$out"; fi
rm -rf "$SLOTS"
holder 2; holder 2; wait_busy 2
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=2 MAPLE_GATE_SLOT_WAIT=4 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_ran app-test x; echo AFTER' "$LIB" 2>&1)"
if echo "$out" | grep -q 'waiting for gate slot (1 ahead; 2/2 slots busy)'; then pass "N=2: two holders fill both slots, the third waits"; else fail "N=2" "$out"; fi
for hp in $HOLD_PIDS; do kill "$hp" 2>/dev/null; done; wait 2>/dev/null; HOLD_PIDS=""
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=0 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_ran app-test x; echo AFTER' "$LIB" 2>&1)"
if [ "$out" = "AFTER" ]; then pass "MAPLE_GATE_SLOTS=0 disables the limiter"; else fail "slots=0" "$out"; fi
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=1 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_heavy_begin; pp_cleanup; ls "$MAPLE_GATE_SLOT_DIR" | grep -c slot-' "$LIB" 2>&1)"
if [ "$out" = "0" ]; then pass "pp_cleanup (EXIT trap) releases the slot"; else fail "release" "$out"; fi

out="$(bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; d="$PP_COMMON/ci-gate-locks/${PP_KEY}-dead.lock"; mkdir -p "$d"; echo 999999 > "$d/pid"; PP_LOCK_WAIT=2 pp_lock dead && echo GOT; pp_unlock' "$LIB" 2>&1)"
if echo "$out" | grep -q '^GOT$'; then pass "a lock whose owner pid is gone (killed gate) is broken at once, not after the TTL"; else fail "dead-owner lock" "$out"; fi
out="$(bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_lock live; test "$(cat "$PP_LOCK_DIR/pid")" = "$$" && echo OWNER_RECORDED; pp_unlock' "$LIB" 2>&1)"
if echo "$out" | grep -q '^OWNER_RECORDED$'; then pass "the lock records its owner pid"; else fail "lock owner pid" "$out"; fi

echo ""
printf "prepush slots self-test: %s failure(s)
" "$FAILURES"
[ "$FAILURES" -eq 0 ]
