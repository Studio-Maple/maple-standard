#!/usr/bin/env bash
# plugin/scripts/prepush/install-hooks.test.sh -- real `git push`es from real worktrees prove
# scripts/install-hooks.mjs makes the pre-push hook fail CLOSED:
#   * a worktree that never ran `npm ci` (no .husky/_) still runs the hook
#   * the hook sees the pushed refs on stdin and its exit code blocks the push
#   * a checkout with no .husky/pre-push REFUSES the push (it used to skip silently)
#   * --check fails when hooksPath is the relative husky one / the stubs are gone
# Hermetic: throwaway repos under a temp dir, a local bare "remote", no network.
set -uo pipefail

# A hook exports GIT_DIR & co. to everything it runs; when this test runs from the
# gate inside a pre-push hook they would point every `git init`/`git config` below
# at the REAL repository (it corrupted core.bare/user/branches once). Hermetic:
for v in $(git rev-parse --local-env-vars 2>/dev/null); do unset "$v"; done
INSTALL="${INSTALL_HOOKS:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-hooks.mjs}"
FAILURES=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { FAILURES=$((FAILURES + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

W="$(mktemp -d 2>/dev/null || mktemp -d -t ihooks)"
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
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
unset HUSKY

git init -q --bare "$W/remote.git"
git init -q -b development "$W/main"
cd "$W/main" || exit 1
must_be_temp "$W/main"
git config user.email t@t; git config user.name t
mkdir .husky
# The committed hook: records its args + stdin, fails when a flag file exists.
cat > .husky/pre-push <<'EOF'
#!/usr/bin/env sh
echo "ran in $(pwd) args: $*" >> "$(git rev-parse --git-common-dir)/hook-ran.log"
echo "GIT_DIR=${GIT_DIR:-unset}" >> "$(git rev-parse --git-common-dir)/hook-env.log"
cat >> "$(git rev-parse --git-common-dir)/hook-stdin.log"
[ -f "$(git rev-parse --git-common-dir)/block-push" ] && { echo "gate says no" >&2; exit 1; }
exit 0
EOF
echo base > f; git add -A; git commit -q -m base
git remote add origin "$W/remote.git"
# Simulate the OLD state: husky's relative hooksPath, and no .husky/_ anywhere.
git config core.hooksPath .husky/_

echo "before the fix (the incident)"
git worktree add -q "$W/wt" -b feat 2>/dev/null
( cd "$W/wt" && echo a > a && git add a && git commit -q -m a && git push -q origin feat >/dev/null 2>&1 )
if [ ! -f "$W/main/.git/hook-ran.log" ]; then pass "old relative .husky/_ with no generated dir: the push ran NO hook (reproduces the hole)"; else fail "reproduce the hole" "hook ran"; fi

echo "install"
node "$INSTALL" --check >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ]; then pass "--check fails before install"; else fail "--check fails before install" "rc=$rc"; fi
node "$INSTALL" --quiet; rc=$?
if [ "$rc" -eq 0 ]; then pass "install succeeds"; else fail "install succeeds" "rc=$rc"; fi
if node "$INSTALL" --check >/dev/null 2>&1; then pass "--check passes after install"; else fail "--check passes after install"; fi
HP="$(git config core.hooksPath)"
case "$HP" in /*|[A-Za-z]:*) pass "core.hooksPath is absolute ($HP)" ;; *) fail "core.hooksPath is absolute" "$HP" ;; esac

echo "worktree that never ran npm ci"
( cd "$W/wt" && echo b > b && git add b && git commit -q -m b && git push -q origin feat >/dev/null 2>&1 ); rc=$?
if [ "$rc" -eq 0 ]; then pass "push from the worktree succeeds when the hook passes"; else fail "push passes" "rc=$rc"; fi
if grep -q "ran in .*wt" "$W/main/.git/hook-ran.log" 2>/dev/null; then pass "the hook RAN, from the worktree's own checkout"; else fail "hook ran in the worktree" "$(cat "$W/main/.git/hook-ran.log" 2>/dev/null)"; fi
if grep -q "refs/heads/feat" "$W/main/.git/hook-stdin.log" 2>/dev/null; then pass "the hook received the pushed refs on stdin"; else fail "stdin refs" "$(cat "$W/main/.git/hook-stdin.log" 2>/dev/null)"; fi
if grep -q "origin" "$W/main/.git/hook-ran.log"; then pass "the hook received git's arguments (remote name)"; else fail "hook args" ""; fi

if grep -q "GIT_DIR=unset" "$W/main/.git/hook-env.log" 2>/dev/null; then pass "the stub scrubbed GIT_DIR from the hook's environment (tests it runs cannot hit the real repo)"; else fail "GIT_DIR scrubbed" "$(cat "$W/main/.git/hook-env.log" 2>/dev/null)"; fi

echo "a red gate blocks the push"
touch "$W/main/.git/block-push"
( cd "$W/wt" && echo c > c && git add c && git commit -q -m c && git push -q origin feat >/dev/null 2>&1 ); rc=$?
if [ "$rc" -ne 0 ]; then pass "hook exit 1 blocks the push from a worktree"; else fail "hook blocks" "rc=$rc"; fi
rm -f "$W/main/.git/block-push"

echo "a checkout without the hook file refuses (fail closed)"
git worktree add -q "$W/old" -b old 2>/dev/null
( cd "$W/old" && git rm -q .husky/pre-push && git commit -q -m "drop hook" && git push -q origin old >/dev/null 2>"$W/refuse.err" ); rc=$?
if [ "$rc" -ne 0 ]; then pass "push REFUSED when .husky/pre-push is missing"; else fail "refuse when missing" "rc=$rc"; fi
if grep -q "missing - refusing" "$W/refuse.err"; then pass "...with a message that says why"; else fail "refusal message" "$(cat "$W/refuse.err")"; fi

echo "main checkout"
( cd "$W/main" && echo m > m && git add m && git commit -q -m m && git push -q origin development >/dev/null 2>&1 ); rc=$?
if [ "$rc" -eq 0 ] && grep -q "ran in .*main" "$W/main/.git/hook-ran.log"; then pass "the main checkout is gated by the same stubs"; else fail "main checkout gated" "rc=$rc"; fi

echo "main checkout whose config says core.bare=true (left behind by a stray test; rev-parse --show-toplevel then fails)"
git config core.bare true
: > "$W/main/.git/hook-ran.log"
( cd "$W/main" && git push -q origin development >/dev/null 2>"$W/bare.err" ); rc=$?
if grep -q "ran in" "$W/main/.git/hook-ran.log"; then pass "the stub still finds the root (pwd fallback) and runs the hook"; else fail "stub works with core.bare=true" "$(cat "$W/bare.err")"; fi
if grep -q "cannot locate" "$W/bare.err"; then fail "no 'cannot locate the worktree root' refusal" "$(cat "$W/bare.err")"; else pass "no 'cannot locate the worktree root' refusal"; fi
git config core.bare false

echo "husky resets core.hooksPath to the relative .husky/_ (what npm ci does)"
git config core.hooksPath .husky/_
: > "$W/main/.git/hook-ran.log"
( cd "$W/wt" && echo d > d && git add d && git commit -q -m d && git push -q origin feat >/dev/null 2>&1 )
if grep -q "ran in .*wt" "$W/main/.git/hook-ran.log"; then pass "a worktree that existed at install time is STILL gated: its .husky/_ holds the fail-closed stubs"; else fail "worktree .husky/_ stubs" "$(cat "$W/main/.git/hook-ran.log")"; fi
if node "$INSTALL" --check >/dev/null 2>&1; then fail "--check notices the reset" ""; else pass "--check notices the reset"; fi
if node "$INSTALL" --quiet && node "$INSTALL" --check >/dev/null 2>&1; then pass "re-running the installer restores the absolute hooksPath"; else fail "heal" ""; fi
git worktree add -q "$W/late" -b late 2>/dev/null
git config core.hooksPath .husky/_
node "$INSTALL" --quiet
if [ -f "$W/late/.husky/_/pre-push" ]; then pass "a worktree created AFTER the first install gets its .husky/_ stubs on the next install"; else fail "late worktree stubs" ""; fi

echo "repair"
rm -rf "$W/main/.git/maple-hooks"
if node "$INSTALL" --check >/dev/null 2>&1; then fail "--check detects a deleted hooks dir" ""; else pass "--check detects a deleted hooks dir"; fi
if node "$INSTALL" --quiet && node "$INSTALL" --check >/dev/null 2>&1; then pass "re-running the installer repairs it"; else fail "repair" ""; fi

echo ""
printf 'install-hooks self-test: %s failure(s)\n' "$FAILURES"
[ "$FAILURES" -eq 0 ]
