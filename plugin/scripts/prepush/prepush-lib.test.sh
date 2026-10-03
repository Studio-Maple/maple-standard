#!/usr/bin/env bash
# plugin/scripts/prepush/prepush-lib.test.sh
#
# Hermetic test of scripts/lib/prepush-lib.sh -- the affected-only selection
# and the tree-bound pass stamp behind the pre-push gate. Builds a throwaway
# repo with a bare "origin", so there is no network and no dependency install.
#
# A gate that skips work is only safe if the skipping rules can be shown to
# fail closed. This file is that proof:
#   - the range comes from the hook's own refs, else @{upstream}, else origin/<default>
#   - NO resolvable range  => FULL
#   - a gate script / lockfile / shared config in the range => FULL
#   - CI_FULL=1 => FULL
#   - the stamp never satisfies a different tree, a dirty tree, a larger change
#     set, or an explicit --full; and a full stamp satisfies everything on its tree
#   - two checkouts never share a cache dir; a second lock holder is refused
#
# Run directly: bash scripts/test/prepush-affected.test.sh

set -uo pipefail

# A hook exports GIT_DIR & co. to everything it runs; when this test runs from the
# gate inside a pre-push hook they would point every `git init`/`git config` below
# at the REAL repository (it corrupted core.bare/user/branches once). Hermetic:
for v in $(git rev-parse --local-env-vars 2>/dev/null); do unset "$v"; done

# This file is run from inside the gate itself (full tier), which exports CI_FULL
# etc.; the cases below assume a clean slate.
unset CI_FULL PP_FORCE_FULL PP_NO_STAMP PP_FULL_RE CI_PREPUSH CI_LOCAL_SELFTEST MAPLE_GATE_SLOTS MAPLE_GATE_SLOT_DIR MAPLE_GATE_SLOT_WAIT PP_LOCK_WAIT PP_LOCK_TTL

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

echo "range + selection"
echo c >> app/src/a.ts; git commit -qam "app change"
out="$(run 'pp_init "$PWD"; pp_want app-lint "^app/" && echo RUN; pp_want admin-lint "^admin/" || echo SKIP; pp_want docs "^docs/" || echo SKIP2' 2>&1)"
echo "$out" | grep -q '^RUN$'   && pass "affected: app change runs an app step"      || fail "app step runs" "$out"
echo "$out" | grep -q '^SKIP$'  && pass "affected: admin step skipped"              || fail "admin step skipped" "$out"
echo "$out" | grep -q 'skipped admin-lint' && pass "skip is printed with its id"    || fail "skip printed" "$out"

# test-only exclusion
echo t > app/src/a.test.ts; git add -A; git commit -qm "test only"
out="$(run 'pp_init "$PWD"; pp_want build "^app/" "\.test\.ts$" && echo RUN || echo SKIP' 2>&1 | tail -1)"
# a.ts changed in the same range, so build still runs; now a range with only the test
git push -q origin HEAD:development 2>/dev/null; git fetch -q origin 2>/dev/null
echo t2 >> app/src/a.test.ts; git commit -qam "test only 2"
out="$(run 'pp_init "$PWD"; pp_want build "^app/" "\.test\.ts$" && echo RUN || echo SKIP' 2>&1 | tail -1)"
[ "$out" = "SKIP" ] && pass "exclude-ere: a test-only change does not trigger the build" || fail "exclude-ere" "$out"
out="$(run 'pp_init "$PWD"; pp_want lint "^app/" && echo RUN || echo SKIP' 2>&1 | tail -1)"
[ "$out" = "RUN" ] && pass "the same change still triggers lint" || fail "lint on test change" "$out"

echo "FULL triggers"
git push -q origin HEAD:development 2>/dev/null; git fetch -q origin 2>/dev/null
echo x >> scripts/ci-local.sh; git commit -qam "gate script"
out="$(run 'pp_init "$PWD"; pp_is_full && echo FULL; pp_want anything "^nothing/" && echo RUN' 2>&1)"
echo "$out" | grep -q '^FULL$' && echo "$out" | grep -q '^RUN$' && pass "gate-script change => FULL, every step runs" || fail "gate script full" "$out"
git push -q origin HEAD:development 2>/dev/null; git fetch -q origin 2>/dev/null
echo '{"x":1}' > package-lock.json; git commit -qam lock
out="$(run 'pp_init "$PWD"; pp_is_full && echo FULL' 2>&1)"
[ "$out" = "FULL" ] && pass "lockfile change => FULL" || fail "lockfile full" "$out"
git push -q origin HEAD:development 2>/dev/null; git fetch -q origin 2>/dev/null
echo '{}' > admin/tsconfig.json; git add -A; git commit -qm tsconfig
out="$(run 'pp_init "$PWD"; pp_is_full && echo FULL' 2>&1)"
[ "$out" = "FULL" ] && pass "shared config (tsconfig) change => FULL" || fail "tsconfig full" "$out"
git push -q origin HEAD:development 2>/dev/null; git fetch -q origin 2>/dev/null
echo n >> docs/d.md; git commit -qam docs
out="$(run 'pp_init "$PWD"; pp_is_full && echo FULL || echo AFFECTED' 2>&1)"
[ "$out" = "AFFECTED" ] && pass "docs-only change stays affected-only" || fail "docs affected" "$out"
out="$(CI_FULL=1 run 'pp_init "$PWD"; pp_is_full && echo FULL' 2>&1)"
[ "$out" = "FULL" ] && pass "CI_FULL=1 => FULL" || fail "CI_FULL" "$out"

echo "no range => FULL (fail closed)"
mkdir "$W/norange" && cd "$W/norange" && git init -q -b development && git commit -q --allow-empty -m x
must_be_temp "$W/norange"
out="$(run 'pp_init "$PWD"; pp_is_full && echo FULL; pp_want s "^nothing/" && echo RUN' 2>&1)"
echo "$out" | grep -q '^FULL$' && echo "$out" | grep -q '^RUN$' && pass "no upstream and no origin => FULL" || fail "no range" "$out"
cd "$W/repo" || exit 1

echo "hook stdin refs"
head="$(git rev-parse HEAD)"; remote="$(git rev-parse origin/development)"
printf 'refs/heads/development %s refs/heads/development %s\n' "$head" "$remote" > "$W/refs"
out="$(run 'pp_init "$PWD" "$(cat '"$W/refs"')"; pp_list_existing "^docs/"; echo "${PP_M[*]}"' 2>&1)"
[ "$out" = "docs/d.md" ] && pass "range = pushed ref vs remote sha" || fail "stdin range" "$out"
zero=0000000000000000000000000000000000000000
printf 'refs/heads/feat %s refs/heads/feat %s\n' "$head" "$zero" > "$W/refs"
out="$(run 'pp_init "$PWD" "$(cat '"$W/refs"')"; pp_list_existing "^docs/"; echo "${PP_M[*]}"' 2>&1)"
[ "$out" = "docs/d.md" ] && pass "new remote branch: base falls back to merge-base with origin/<default>" || fail "new branch range" "$out"

echo "deleted files"
git push -q origin HEAD:development 2>/dev/null; git fetch -q origin 2>/dev/null
git rm -q app/src/a.ts; git commit -qm del
out="$(run 'pp_init "$PWD"; pp_list_deleted "^app/"; echo "${PP_M[*]}"; echo --; pp_list_existing "^app/"; echo "${PP_M[*]}"' 2>&1)"
[ "$out" = "app/src/a.ts
--" ] && pass "a deleted path is reported by pp_deleted and dropped by pp_existing" || fail "deleted" "$out"

echo "import graph (knip / depcruise trigger)"
G='pp_init "$PWD"; if pp_graph_changed "^(app|admin)/src/.*\.ts$"; then echo GRAPH; else echo NOGRAPH; fi'
out="$(run "$G" 2>&1 | tail -1)"
[ "$out" = "GRAPH" ] && pass "a deleted source file changes the graph" || fail "deleted => graph" "$out"
git push -q origin HEAD:development 2>/dev/null; git fetch -q origin 2>/dev/null
echo "// body only" >> admin/src/b.ts; git commit -qam "body edit"
out="$(run "$G" 2>&1 | tail -1)"
[ "$out" = "NOGRAPH" ] && pass "a body-only edit does not" || fail "body edit => no graph" "$out"
git push -q origin HEAD:development 2>/dev/null; git fetch -q origin 2>/dev/null
echo "import x from 'y'" >> admin/src/b.ts; git commit -qam "import edit"
out="$(run "$G" 2>&1 | tail -1)"
[ "$out" = "GRAPH" ] && pass "a changed import line does" || fail "import edit => graph" "$out"
git push -q origin HEAD:development 2>/dev/null; git fetch -q origin 2>/dev/null
echo n > admin/src/new.ts; git add -A; git commit -qm "new file"
out="$(run "$G" 2>&1 | tail -1)"
[ "$out" = "GRAPH" ] && pass "an added source file does" || fail "added => graph" "$out"
git push -q origin HEAD:development 2>/dev/null; git fetch -q origin 2>/dev/null
echo "// still body" >> admin/src/new.ts; echo "# doc" >> docs/d.md; git commit -qam "body+doc"
out="$(run "$G" 2>&1 | tail -1)"
[ "$out" = "NOGRAPH" ] && pass "unrelated paths and body edits stay NOGRAPH" || fail "unrelated => no graph" "$out"
git push -q origin HEAD:development 2>/dev/null; git fetch -q origin 2>/dev/null

echo "stamp"
git push -q origin HEAD:development 2>/dev/null; git fetch -q origin 2>/dev/null
echo s >> admin/src/b.ts; git commit -qam "admin"
check "no stamp yet => not covered" 1 run 'pp_init "$PWD"; pp_stamp_covers gate'
check "write a stamp" 0 run 'pp_init "$PWD"; pp_stamp_write gate'
check "same tree, same change set => covered" 0 run 'pp_init "$PWD"; pp_stamp_covers gate'
check "explicit CI_FULL never reuses" 1 env CI_FULL=1 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_stamp_covers gate' "$LIB"
check "PP_NO_STAMP=1 never reuses" 1 env PP_NO_STAMP=1 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_stamp_covers gate' "$LIB"
echo '#' >> docs/d.md; git commit -qam "docs on top"
check "different tree sha => not covered" 1 run 'pp_init "$PWD"; pp_stamp_covers gate'
echo more >> docs/d.md
check "dirty tracked tree => not covered, no stamp written" 1 run 'pp_init "$PWD"; pp_stamp_covers gate'
git checkout -q docs/d.md
# a bigger change set on the stamped tree: stamp the tree with a small set, ask with a larger one
git push -q origin HEAD:development 2>/dev/null; git fetch -q origin 2>/dev/null
echo q >> admin/src/b.ts; git commit -qam "small"
run 'pp_init "$PWD"; pp_stamp_write gate'
git branch -q wide origin/development  # base further back => larger change set
check "larger change set on the same tree => not covered" 1 run 'pp_init "$PWD"; PP_FILES=(admin/src/b.ts app/src/zzz.ts); pp_stamp_covers gate'
check "smaller subset on the same tree => covered" 0 run 'pp_init "$PWD"; pp_stamp_covers gate'
# full stamp covers anything on its tree
echo r >> admin/src/b.ts; git commit -qam "tree for full stamp"
run 'PP_FORCE_FULL=1 pp_init "$PWD"; pp_stamp_write gate'
check "a FULL stamp covers an affected run on that tree" 0 run 'pp_init "$PWD"; pp_stamp_covers gate'
check "...but is bound to the tree: not after another commit" 1 bash -c 'echo z > docs/z.md; git add -A; git commit -qm z; . "$0"; pp_init "$PWD"; pp_stamp_covers gate' "$LIB"

echo "caches and locks"
a="$(run 'pp_init "$PWD"; pp_cache_dir eslint-app; echo "$PP_CACHE"')"
mkdir -p "$W/repo2" && cp -r "$W/repo/.git" "$W/repo2/.git" 2>/dev/null
b="$(cd "$W/repo2" && run 'pp_init "$PWD"; pp_cache_dir eslint-app; echo "$PP_CACHE"')"
[ -n "$a" ] && [ -n "$b" ] && [ "$a" != "$b" ] && pass "two checkouts get different cache dirs" || fail "cache dirs" "$a vs $b"
echo "$a" | grep -q "node_modules/.cache/prepush/" && pass "cache lives under node_modules/.cache/prepush" || fail "cache location" "$a"
k1="$(bash -c 'set -euo pipefail; . "$0"; _pp_key_for /a/b; echo "$PP_KEY"' "$LIB")"; k2="$(bash -c 'set -euo pipefail; . "$0"; _pp_key_for /a/c; echo "$PP_KEY"' "$LIB")"
k3="$(bash -c 'set -euo pipefail; . "$0"; _pp_key_for /very/long/path/to/some/deeply/nested/worktree/checkout/that/exceeds/sixty/chars/aaa; echo "${#PP_KEY}"' "$LIB")"
[ -n "$k1" ] && [ -n "$k2" ] && [ "$k1" != "$k2" ] && pass "a SHORT checkout path still gets a non-empty, distinct key" || fail "short path key" "[$k1] [$k2]"
[ "$k3" = "60" ] && pass "a long path key is capped at 60 chars" || fail "long path key" "$k3"
out="$(bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_lock t || exit 9; ( PP_LOCK_WAIT=1 pp_lock t && echo SECOND_GOT_IT || echo SECOND_REFUSED ); pp_unlock; pp_lock t && echo REACQUIRED' "$LIB" 2>/dev/null)"
echo "$out" | grep -q SECOND_REFUSED && echo "$out" | grep -q REACQUIRED && pass "lock: second holder refused, reacquirable after release" || fail "lock" "$out"

echo "machine-wide gate slots"
SLOTS="$W/slots"
holder() { # holder <n> -> background process that holds a slot for ~25s
  MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS="$1" bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_heavy_begin; sleep 25' "$LIB" >/dev/null 2>&1 &
  HOLD_PIDS="${HOLD_PIDS:-} $!"
}
wait_busy() { # wait_busy <count>
  local i=0
  while [ "$(ls -d "$SLOTS"/slot-* 2>/dev/null | wc -l)" -lt "$1" ] && [ "$i" -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
}
holder 1; wait_busy 1
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=1 MAPLE_GATE_SLOT_WAIT=4 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_ran app-test x; echo AFTER' "$LIB" 2>&1)"
echo "$out" | grep -q 'waiting for gate slot (1 ahead' && pass "a second heavy gate with N=1 prints 'waiting for gate slot (k ahead)'" || fail "waiting message" "$out"
echo "$out" | grep -q 'running anyway' && echo "$out" | grep -q '^AFTER$' && pass "the limiter is advisory: it runs after the wait cap instead of failing" || fail "wait cap" "$out"
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=1 MAPLE_GATE_SLOT_WAIT=2 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_ran gitleaks x; pp_ran docs-drift x; echo AFTER' "$LIB" 2>&1)"
[ "$out" = "AFTER" ] && pass "light steps (gitleaks, docs-drift) never queue for a slot" || fail "light steps" "$out"
for hp in $HOLD_PIDS; do kill "$hp" 2>/dev/null; done; wait 2>/dev/null; HOLD_PIDS=""
# killed holders leave their slot dir behind: the dead pid must free it at once
[ -d "$SLOTS/slot-1" ] && pass "(setup) the killed holder left a stale slot behind" || pass "(setup) holder cleaned up"
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=1 MAPLE_GATE_SLOT_WAIT=6 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_heavy_begin; echo GOT' "$LIB" 2>&1)"
echo "$out" | grep -q '^GOT$' && ! echo "$out" | grep -q 'waiting' && pass "a dead PID releases its slot immediately (stale-safe)" || fail "stale slot" "$out"
rm -rf "$SLOTS"; mkdir -p "$SLOTS/slot-1"; echo 999999 > "$SLOTS/slot-1/pid"
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=1 MAPLE_GATE_SLOT_WAIT=6 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_heavy_begin; echo GOT' "$LIB" 2>&1)"
echo "$out" | grep -q '^GOT$' && ! echo "$out" | grep -q 'waiting' && pass "a slot owned by a nonexistent PID is reclaimed" || fail "dead pid slot" "$out"
rm -rf "$SLOTS"
holder 2; holder 2; wait_busy 2
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=2 MAPLE_GATE_SLOT_WAIT=4 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_ran app-test x; echo AFTER' "$LIB" 2>&1)"
echo "$out" | grep -q 'waiting for gate slot (1 ahead; 2/2 slots busy)' && pass "N=2: two holders fill both slots, the third waits" || fail "N=2" "$out"
for hp in $HOLD_PIDS; do kill "$hp" 2>/dev/null; done; wait 2>/dev/null; HOLD_PIDS=""
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=0 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_ran app-test x; echo AFTER' "$LIB" 2>&1)"
[ "$out" = "AFTER" ] && pass "MAPLE_GATE_SLOTS=0 disables the limiter" || fail "slots=0" "$out"
out="$(MAPLE_GATE_SLOT_DIR="$SLOTS" MAPLE_GATE_SLOTS=1 bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_heavy_begin; pp_cleanup; ls "$MAPLE_GATE_SLOT_DIR" | grep -c slot-' "$LIB" 2>&1)"
[ "$out" = "0" ] && pass "pp_cleanup (EXIT trap) releases the slot" || fail "release" "$out"

out="$(bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; d="$PP_COMMON/ci-gate-locks/${PP_KEY}-dead.lock"; mkdir -p "$d"; echo 999999 > "$d/pid"; PP_LOCK_WAIT=2 pp_lock dead && echo GOT; pp_unlock' "$LIB" 2>&1)"
echo "$out" | grep -q '^GOT$' && pass "a lock whose owner pid is gone (killed gate) is broken at once, not after the TTL" || fail "dead-owner lock" "$out"
out="$(bash -c 'set -euo pipefail; . "$0"; pp_init "$PWD"; pp_lock live; test "$(cat "$PP_LOCK_DIR/pid")" = "$$" && echo OWNER_RECORDED; pp_unlock' "$LIB" 2>&1)"
echo "$out" | grep -q '^OWNER_RECORDED$' && pass "the lock records its owner pid" || fail "lock owner pid" "$out"

echo ""
printf 'prepush-affected self-test: %s failure(s)\n' "$FAILURES"
[ "$FAILURES" -eq 0 ]
