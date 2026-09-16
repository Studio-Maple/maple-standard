# shellcheck shell=bash
# plugin/scripts/agent-wt/maple-lib.sh — shared helpers for the maple-standard
# parallel-agent worktree workflow (maple-start / maple-land / maple-preview /
# maple-reap). Ported + generalized from VeHagita's scripts/agent-wt/_lib.sh
# (D085 / #T070 there) — this version reads every project-specific value from
# maple.config.json instead of hardcoding it, so the same scripts work in any
# adopting project.
#
# The model in one line: each parallel Claude session works in its OWN git
# worktree + ephemeral branch (named per `worktrees.namePattern`, default
# `agent/<slug>`); the ONLY path back to the target branch is `maple-land`,
# which holds a GLOBAL lock while it rebase -> gate -> pushes. The lock
# serializes both the git integration AND the gate command, so two sessions
# can never collide on the tree, the branch, or the gate.
#
# maple.config.json keys this file reads (all optional — sane defaults below).
# CANONICAL per docs/standard-architecture.md's schema (docs/decisions.md
# D002-D011; reconciled #T11 — this file used to invent its own flat
# `worktree.*` block, now retired in favor of the schema's `repo.*` /
# `worktrees.*` blocks, one key set, no aliases):
#   repo.remote                      default "origin"
#   repo.devBranch / repo.prodBranch target branch: devBranch if set (dual-
#                                     checkout, D008), else prodBranch, else
#                                     origin/HEAD's branch, else "main"
#   worktrees.root                   default ".worktrees" (inside the repo,
#                                     gitignored — see maple_ensure_gitignored)
#   worktrees.namePattern            default "agent/<slug>" — `<slug>` is
#                                     substituted; the branch prefix/suffix
#                                     are derived from this pattern, no
#                                     separate `branchPrefix` key anymore
#   worktrees.nodeModulesDirs        default ["."]  (dirs to junction-link node_modules from)
#   worktrees.envFiles               default []     (gitignored env files to hardlink)
#   worktrees.freshDepsCommand       default "npm ci"
#   worktrees.lock.ttlSeconds        default 900   (15min — stale-lock steal threshold. m5:
#                                     was 1800 against a 300s default wait — a crash between
#                                     mkdir and the meta write left the lock unstealable for up
#                                     to 30min while every waiting caller had already given up
#                                     at 5min. Halved rather than matched to waitSeconds exactly:
#                                     TTL also governs stealing from a genuinely slow-but-alive
#                                     holder (a real gate run "can be minutes"), so it can't drop
#                                     all the way to waitSeconds without risking preemption of a
#                                     live process; waitSeconds can't rise to meet TTL without
#                                     risking a Claude Code Bash call's own timeout firing first
#                                     (see below) — 900s narrows the abandoned-lock gap from 25min
#                                     to 10min under those two constraints instead of closing it.)
#   worktrees.lock.waitSeconds       default 300   (5min — total wait before giving up; kept
#                                     well under a typical Claude Code Bash call's own timeout,
#                                     which would otherwise fire first and leave the caller
#                                     with no clean "gave up" message at all)
#   worktrees.lock.pollSeconds       default 5
#
# Malformed maple.config.json (invalid JSON)? Every `maple_cfg` lookup below
# fails open to its default (never blocks the worktree flow), but prints a
# one-time warning pointing at the validator — see maple_check_config below.

set -euo pipefail

# ── config reader (shells out to node — required anyway for the plugin's own
# hooks, so this is not a new dependency). Missing config / missing node /
# missing key all fall back to the supplied default. ────────────────────────
maple_cfg() {
  # maple_cfg <dotted.path> <default>
  local path="$1" def="${2:-}" cfg="$MAPLE_REPO_ROOT/maple.config.json"
  if [ -f "$cfg" ] && command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      try {
        const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const keys = process.argv[2].split(".");
        let v = cfg;
        for (const k of keys) v = (v && typeof v === "object") ? v[k] : undefined;
        if (v === undefined || v === null) process.stdout.write(process.argv[3] || "");
        else if (typeof v === "object") process.stdout.write(JSON.stringify(v));
        else process.stdout.write(String(v));
      } catch { process.stdout.write(process.argv[3] || ""); }
    ' "$cfg" "$path" "$def"
  else
    printf '%s' "$def"
  fi
}

# maple_cfg_array <dotted.path> <default-single-item> — one item per line.
# Used for array-valued keys (nodeModulesDirs, envFiles).
maple_cfg_array() {
  local path="$1" def="${2:-}" cfg="$MAPLE_REPO_ROOT/maple.config.json"
  if [ -f "$cfg" ] && command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      try {
        const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
        const keys = process.argv[2].split(".");
        let v = cfg;
        for (const k of keys) v = (v && typeof v === "object") ? v[k] : undefined;
        if (Array.isArray(v)) { for (const x of v) process.stdout.write(String(x) + "\n"); }
        else if (process.argv[3]) process.stdout.write(process.argv[3] + "\n");
      } catch { if (process.argv[3]) process.stdout.write(process.argv[3] + "\n"); }
    ' "$cfg" "$path" "$def"
  elif [ -n "$def" ]; then
    printf '%s\n' "$def"
  fi
}

# ── paths ──────────────────────────────────────────────────────────────────
MAPLE_REPO_ROOT="$(git rev-parse --show-toplevel)"
MAPLE_COMMON_DIR="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
# The primary worktree is the one whose .git is a real dir (== COMMON_DIR's parent).
MAPLE_MAIN_ROOT="$(dirname "$MAPLE_COMMON_DIR")"
MAPLE_PROJECT_NAME="$(basename "$MAPLE_MAIN_ROOT")"

# ── logging (stderr, so stdout stays parseable) ──────────────────────────────
maple_log()  { printf '\033[36m[maple]\033[0m %s\n' "$*" >&2; }
maple_warn() { printf '\033[33m[maple] ! %s\033[0m\n' "$*" >&2; }
maple_die()  { printf '\033[31m[maple] \xe2\x9c\x97 %s\033[0m\n' "$*" >&2; exit 1; }
maple_ok()   { printf '\033[32m[maple] \xe2\x9c\x93 %s\033[0m\n' "$*" >&2; }

# ── config sanity (non-fatal — points at the validator, never blocks) ───────
# Malformed JSON makes every maple_cfg lookup above silently fall back to its
# default; that's fine for one bad key but confusing when the whole file is
# broken. Warn once per invocation so the failure isn't silent.
maple_check_config() {
  local cfg="$MAPLE_REPO_ROOT/maple.config.json"
  [ -f "$cfg" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  local validator="${CLAUDE_PLUGIN_ROOT:-$(dirname "$0")/../..}/scripts/validate-config.mjs"
  [ -f "$validator" ] || return 0
  if ! node "$validator" "$cfg" >/dev/null 2>&1; then
    maple_warn "maple.config.json has validation problems — run: node \"\$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs\" (falling back to defaults for anything unreadable)"
  fi
}
maple_check_config

# worktrees.namePattern (canonical, default "agent/<slug>") replaces the old
# invented `worktree.branchPrefix` key — the branch name is the pattern with
# `<slug>` substituted; prefix/suffix around the placeholder are derived from
# it so a project can still customize e.g. a trailing suffix.
MAPLE_NAME_PATTERN="${MAPLE_NAME_PATTERN:-$(maple_cfg worktrees.namePattern 'agent/<slug>')}"
case "$MAPLE_NAME_PATTERN" in
  *'<slug>'*) : ;;
  *) maple_warn "worktrees.namePattern '$MAPLE_NAME_PATTERN' has no <slug> placeholder — falling back to 'agent/<slug>'"; MAPLE_NAME_PATTERN='agent/<slug>' ;;
esac
MAPLE_NAME_PREFIX="${MAPLE_NAME_PATTERN%%<slug>*}"
MAPLE_NAME_SUFFIX="${MAPLE_NAME_PATTERN##*<slug>}"

MAPLE_REMOTE="${MAPLE_REMOTE:-$(maple_cfg repo.remote origin)}"

_maple_default_target_branch() {
  # repo.devBranch (dual-checkout, D008) wins if set — that's the ongoing
  # integration branch; repo.prodBranch next (single-checkout); else detect
  # the remote's default branch; else "main".
  local dev prod; dev="$(maple_cfg repo.devBranch '')"; prod="$(maple_cfg repo.prodBranch '')"
  if [ -n "$dev" ]; then printf '%s' "$dev"; return; fi
  if [ -n "$prod" ]; then printf '%s' "$prod"; return; fi
  local head
  head="$(git symbolic-ref "refs/remotes/$MAPLE_REMOTE/HEAD" 2>/dev/null | sed "s#refs/remotes/$MAPLE_REMOTE/##")"
  printf '%s' "${head:-main}"
}
MAPLE_TARGET="${MAPLE_TARGET:-$(_maple_default_target_branch)}"

_maple_default_wt_root() {
  local cfgVal; cfgVal="$(maple_cfg worktrees.root '')"
  if [ -n "$cfgVal" ]; then
    case "$cfgVal" in
      /*|[A-Za-z]:*) printf '%s' "$cfgVal" ;;                       # absolute
      *) printf '%s/%s' "$MAPLE_MAIN_ROOT" "$cfgVal" ;;             # relative to repo root
    esac
    return
  fi
  printf '%s/.worktrees' "$MAPLE_MAIN_ROOT"
}
MAPLE_WT_ROOT="${MAPLE_WT_ROOT:-$(_maple_default_wt_root)}"

MAPLE_LOCK_DIR="$MAPLE_COMMON_DIR/maple-land.lock"
MAPLE_PREVIEW_NAME="_preview"

# Lock tuning — a full gate run can be minutes; generous TTL + wait. m5: TTL
# default reconciled with waitSeconds — see the header comment above.
MAPLE_LOCK_TTL="${MAPLE_LOCK_TTL:-$(maple_cfg worktrees.lock.ttlSeconds 900)}"
MAPLE_LOCK_WAIT="${MAPLE_LOCK_WAIT:-$(maple_cfg worktrees.lock.waitSeconds 300)}"
MAPLE_LOCK_POLL="${MAPLE_LOCK_POLL:-$(maple_cfg worktrees.lock.pollSeconds 5)}"

# ── slug validation ──────────────────────────────────────────────────────────
maple_slug_validate() {
  local slug="$1"
  [ -n "$slug" ] || maple_die "empty slug. Usage: <cmd> <slug>"
  case "$slug" in
    *[!a-z0-9-]*) maple_die "slug '$slug' invalid — use lowercase letters, digits, hyphens only." ;;
  esac
  case "$slug" in
    -*|*-) maple_die "slug '$slug' must not start or end with a hyphen." ;;
  esac
}

maple_branch_for() { printf '%s%s%s' "$MAPLE_NAME_PREFIX" "$1" "$MAPLE_NAME_SUFFIX"; }
maple_dir_for()    { printf '%s/%s' "$MAPLE_WT_ROOT" "$1"; }

# Normalize a path to the SAME form `git worktree list --porcelain` prints,
# for STRING comparison only (never needed for filesystem calls — git-bash
# resolves either form transparently). On Windows, `git worktree list
# --porcelain` prints Windows-mixed form (`C:/Users/...`) while every path
# this script builds from `git rev-parse --git-common-dir` + `pwd` (see
# MAPLE_COMMON_DIR/MAPLE_MAIN_ROOT/MAPLE_WT_ROOT above) is POSIX form
# (`/c/Users/...`) — a prefix `case`/`==` match between the two silently
# never fires (BL-2: maple-reap.sh's worktree-list walk skipped every
# worktree, reporting "0 removed"). `cygpath -m` converts POSIX -> Windows-
# mixed; on non-Windows `cygpath` doesn't exist and paths are already one
# consistent POSIX form on both sides, so this is a no-op passthrough there.
maple_norm_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1" 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1"
  fi
}

# Is $1 a branch produced by worktrees.namePattern (i.e. an agent worktree
# branch)? If so, strip the pattern's prefix/suffix and print the slug.
maple_is_agent_branch() {
  case "$1" in
    "$MAPLE_NAME_PREFIX"*"$MAPLE_NAME_SUFFIX") return 0 ;;
    *) return 1 ;;
  esac
}
maple_slug_from_branch() {
  local b="${1#"$MAPLE_NAME_PREFIX"}"
  b="${b%"$MAPLE_NAME_SUFFIX"}"
  printf '%s' "$b"
}

# ── node_modules / env-file linking ──────────────────────────────────────────
# Windows note: git-bash `ln -s` on a DIRECTORY silently deep-copies (or
# leaves an empty dir) when MSYS winsymlinks isn't set — it does NOT create a
# working link. So on Windows we use a directory junction (`mklink /J`, no
# admin needed); on Unix a real symlink.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) MAPLE_IS_WINDOWS=true ;;
  *)                    MAPLE_IS_WINDOWS=false ;;
esac

_maple_link_dir() {
  local src="$1" dst="$2"
  # If dst already exists as a LINK (re-link of an existing worktree, e.g.
  # maple-preview), remove the link itself first — deleters that follow
  # junctions (git's recursive delete does; rm behavior is MSYS-version-
  # dependent) would recurse into the TARGET (the main checkout's real
  # node_modules). rmdir/rm -f remove only the reparse point; the rm -rf
  # below then only ever sees a plain leftover dir.
  if $MAPLE_IS_WINDOWS; then
    cmd //c rmdir "$(cygpath -w "$dst")" >/dev/null 2>&1 || true
  elif [ -L "$dst" ]; then
    rm -f "$dst" 2>/dev/null || true
  fi
  rm -rf "$dst" 2>/dev/null || true
  if $MAPLE_IS_WINDOWS; then
    cmd //c mklink //J "$(cygpath -w "$dst")" "$(cygpath -w "$src")" >/dev/null 2>&1
  else
    ln -s "$src" "$dst" 2>/dev/null
  fi
}

# maple.config.json worktrees.nodeModulesDirs — dirs (relative to repo root)
# whose node_modules gets junction-linked from the main checkout into a new
# worktree. Default: just the repo root itself.
maple_link_node_modules() {
  local wt="$1" d src dst
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    src="$MAPLE_MAIN_ROOT/$d/node_modules"
    dst="$wt/$d/node_modules"
    [ -d "$src" ] || continue
    [ -d "$wt/$d" ] || continue
    if _maple_link_dir "$src" "$dst"; then
      maple_log "linked $d/node_modules -> main"
    else
      maple_warn "could not link $d/node_modules (try --fresh-deps?)"
    fi
  done < <(maple_cfg_array worktrees.nodeModulesDirs '.')
}

# maple.config.json worktrees.envFiles — gitignored env files (relative to
# repo root) a worktree needs but doesn't get on checkout. Default: none —
# projects with a dev server / build that needs local env vars should set
# this (e.g. [".env.local"]).
maple_link_env_files() {
  local wt="$1" f src dst
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    src="$MAPLE_MAIN_ROOT/$f"; dst="$wt/$f"
    [ -f "$src" ] || continue
    [ -e "$dst" ] && continue          # never clobber an existing worktree env file
    [ -d "$(dirname "$dst")" ] || continue
    if $MAPLE_IS_WINDOWS; then
      cmd //c mklink //H "$(cygpath -w "$dst")" "$(cygpath -w "$src")" >/dev/null 2>&1 \
        && maple_log "linked $f -> main" || maple_warn "could not link env $f"
    else
      ln -s "$src" "$dst" 2>/dev/null && maple_log "linked $f -> main" || maple_warn "could not link env $f"
    fi
  done < <(maple_cfg_array worktrees.envFiles '')
}

# Remove node_modules junctions before deleting a worktree. CRITICAL on
# Windows: `rm -rf` through a junction would recurse into and DELETE the main
# checkout's real node_modules. `rmdir` on a junction removes only the link.
maple_unlink_node_modules() {
  local wt="$1" d dst
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    dst="$wt/$d/node_modules"
    [ -e "$dst" ] || continue
    if $MAPLE_IS_WINDOWS; then
      cmd //c rmdir "$(cygpath -w "$dst")" >/dev/null 2>&1 || true
    else
      [ -L "$dst" ] && rm -f "$dst" || true
    fi
  done < <(maple_cfg_array worktrees.nodeModulesDirs '.')
}

# ── generic: ensure an entry is gitignored ──────────────────────────────────
# MJ-7: originally written for .loop-state/ only (loop-state-gitignore was
# dev-burner.md prose — a manual grep + append instruction Claude followed at
# orchestrator step 1); a loop run STANDALONE under plain `/loop` (never
# through /dev-burner) skipped it entirely, so its `git add -A` could stage
# .loop-state/*.json scratch files. Generalized so the worktree-creation path
# (maple-start.sh) can self-heal `.worktrees/` into .gitignore the same way,
# without duplicating this hard-won correctness logic. Sourced by every
# agent-wt script AND every loop command file (all of them already
# `. maple-lib.sh` at their own step 0), so calling this covers every path.
# Idempotent — only appends if the entry's line is genuinely missing; never
# touches .gitignore otherwise. Operates on the CURRENT worktree (may be the
# standing dev-burner one, or any other), not MAPLE_MAIN_ROOT, since
# .gitignore is branch-tracked content.
maple_ensure_gitignored() {
  local entry="$1" wt gi pattern commit_msg
  wt="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0
  gi="$wt/.gitignore"

  # m7: match the entry with or without a trailing `/` as a WHOLE LINE,
  # tolerant of a CRLF-terminated .gitignore (a Windows checkout with no
  # `*.gitignore text eol=lf` pin) — a plain `grep -qxF "$entry/"` treats the
  # trailing `\r` as part of the line content and never matches a CRLF file,
  # so every single cycle re-appended a duplicate entry. The trailing `/?`
  # also means a project that already wrote the bare (no-slash) form
  # (matches the dir either way in a .gitignore) isn't treated as missing
  # just because it lacks the slash.
  pattern="^$(printf '%s' "${entry%/}" | sed 's/[.[\*^$()+?{|]/\\&/g')/?\r?\$"
  if [ -f "$gi" ] && grep -Eq "$pattern" "$gi" 2>/dev/null; then
    return 0
  fi

  # B3: a .gitignore whose last line has no trailing newline would otherwise
  # get our append glued onto it — e.g. `node_modules` (no final \n) becomes
  # `node_modules.loop-state/`, which un-ignores `node_modules` AND fails to
  # ignore the new entry. Reproduced with a real credential file: an
  # unterminated `.env.local` line as the last line of .gitignore became
  # `.env.local.loop-state/`, un-ignoring `.env.local` — a subsequent loop
  # `git add -A` would then stage it. Ensure the file ends in a newline
  # first. (Command substitution strips ALL trailing newlines from its
  # output, so `$(tail -c1 "$gi")` is empty exactly when the file already
  # ends in one — this correctly no-ops on an already well-formed file.)
  if [ -f "$gi" ] && [ -s "$gi" ] && [ -n "$(tail -c1 "$gi" 2>/dev/null)" ]; then
    printf '\n' >> "$gi"
  fi

  printf '%s\n' "$entry" >> "$gi"

  # M1: `--only` commits exactly the CURRENT WORKING-TREE content of the
  # named path, ignoring (and never staging/touching) anything else already
  # in the index — a plain `git add .gitignore && git commit` here would
  # sweep a user's unrelated already-staged work into this chore commit
  # (reproduced with a staged wip.txt landing inside it). On any failure,
  # nothing is left staged either way (m8) — `--only` never modifies the
  # index for other paths, and doesn't require a prior `git add` for this
  # one.
  commit_msg="chore: gitignore $entry"
  if (cd "$wt" && git commit --only .gitignore --quiet -m "$commit_msg"); then
    maple_log "added $entry to .gitignore (committed)"
  else
    maple_warn "added $entry to .gitignore but could not auto-commit it — commit manually"
  fi
}

# Thin wrapper — kept so every existing caller (loop-pack commands + this
# file's own callers) is untouched.
maple_ensure_loop_state_gitignored() {
  maple_ensure_gitignored '.loop-state/'
}

# Strip EVERY reparse point (junction/symlink) inside a worktree — the links
# themselves, never their targets. maple_unlink_node_modules removes the one
# junction WE made, but build output contains links we didn't: Next.js/
# Turbopack writes junctions under .next/node_modules/ that TARGET the main
# checkout's real .pnpm dirs (require-in-the-middle / import-in-the-middle,
# the Sentry require-hook externals). `git worktree remove --force` — our
# own first teardown step — FOLLOWS junctions in its recursive delete
# (verified by sandbox repro: it empties the target and leaves the dir;
# current MSYS `rm -rf` and `cmd rmdir /s` unlink junctions safely), which
# gutted the main tree's packages three times (2026-07-28..30, maple-pole).
# POSIX rm never follows symlinks — Windows only. Delegated to
# strip-reparse-points.ps1 (a walk that does NOT descend through links —
# PS 5.1's -Recurse follows junctions).
maple_strip_reparse_points() {
  local wt="$1"
  $MAPLE_IS_WINDOWS || return 0
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
    -File "$(cygpath -w "$(dirname "${BASH_SOURCE[0]}")/strip-reparse-points.ps1")" \
    -Root "$(cygpath -w "$wt")" >/dev/null 2>&1 || true
}

# Safely remove a worktree dir: unlink node_modules junctions, strip every
# remaining reparse point (see above — .next contains junctions into the main
# tree), then let git remove it; fall back to a manual (now link-free, so
# safe) rm + prune.
maple_remove_worktree() {
  local wt="$1"
  maple_unlink_node_modules "$wt"
  maple_strip_reparse_points "$wt"
  if git worktree remove --force "$wt" 2>/dev/null; then return 0; fi
  rm -rf "$wt" 2>/dev/null \
    || { $MAPLE_IS_WINDOWS && cmd //c rmdir //s //q "$(cygpath -w "$wt")" >/dev/null 2>&1; } || true
  git worktree prune
}

# ── cross-platform port kill ─────────────────────────────────────────────────
maple_kill_port() {
  local port="$1" pid=""
  if command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -ti "tcp:${port}" 2>/dev/null | head -1 || true)"
  elif command -v ss >/dev/null 2>&1; then
    pid="$(ss -tlnp "sport = :${port}" 2>/dev/null | awk '/LISTEN/{match($0,/pid=([0-9]+)/,a); print a[1]}' | head -1 || true)"
  elif command -v powershell.exe >/dev/null 2>&1; then
    pid="$(powershell.exe -NoProfile -NonInteractive -Command \
      "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess" 2>/dev/null | tr -d '\r' || true)"
  fi
  [ -n "$pid" ] || return 0
  maple_log "freeing port ${port} (pid ${pid})"
  kill "$pid" 2>/dev/null \
    || powershell.exe -NoProfile -NonInteractive -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue" 2>/dev/null \
    || true
}

# ── the global lock ──────────────────────────────────────────────────────────
# `mkdir` is atomic on every platform -> the canonical no-deps mutex. The
# winner writes a meta file (pid + epoch + slug) so others can detect a stale
# holder.
_maple_now()        { date +%s; }
_maple_lock_meta()  { printf '%s\n%s\n%s\n' "$$" "$(_maple_now)" "${1:-?}" > "$MAPLE_LOCK_DIR/meta"; }
_maple_lock_pid()   { sed -n '1p' "$MAPLE_LOCK_DIR/meta" 2>/dev/null || echo ""; }
_maple_lock_epoch() { sed -n '2p' "$MAPLE_LOCK_DIR/meta" 2>/dev/null || echo 0; }
_maple_lock_slug()  { sed -n '3p' "$MAPLE_LOCK_DIR/meta" 2>/dev/null || echo "?"; }

_maple_pid_alive() { kill -0 "$1" 2>/dev/null; }

# mtime of a dir, epoch seconds. GNU stat (Linux, git-bash/MSYS), then BSD
# stat (macOS); if neither exists, fail open to "just now" (age 0) rather
# than mis-declaring a lock stale because `stat` itself is missing.
_maple_dir_mtime() {
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || _maple_now
}

# Steal the lock iff its holder is dead OR older than TTL (crash recovery).
#
# MJ-2: `mkdir` (the atomic acquire) and `_maple_lock_meta` (the pid/epoch
# write) are two separate steps — a competitor that loses the `mkdir` race
# can observe the lock dir WITH NO meta file yet, a window of roughly
# "however long the write takes" (~ms), not zero. The old logic read a
# missing meta as pid="" / epoch=0, computed an enormous fake age, and
# declared the brand-new lock stale — a second process could then rm -rf +
# recreate it, and BOTH sessions would believe they held the lock.
#
# Fix: a missing/unreadable meta is NOT automatically stale. Fall back to
# the LOCK DIRECTORY's own mtime (set the instant `mkdir` succeeded) for the
# age computation instead — only a lock dir that is itself genuinely older
# than the TTL with no meta ever written (a holder that crashed before
# finishing the write) counts as stale.
#
# m4: clock skew can put a dir's mtime in the FUTURE relative to `date +%s`
# (e.g. a VM/container whose clock jumps) — an un-clamped `now - mtime` goes
# negative, and `[ age -ge TTL ]` is then never true, so an abandoned lock
# with a skewed mtime could NEVER be reclaimed. Clamp both age computations
# below to a minimum of 0 via _maple_clamp_age.
#
# m6: a corrupted meta file (line 2 not a plain integer — truncated write,
# manual edit, etc.) fed straight into `$(( now - epoch ))` is a bash
# arithmetic-context syntax error, and under `set -u` a bareword inside that
# expression that bash treats as a variable reference dies with "unbound
# variable" — killing maple-land mid-flight instead of just mis-judging one
# lock. Sanitize epoch to digits-only first; on garbage, treat it as "just
# acquired now" (age 0) — fail SAFE toward "not stale" (never steal from a
# holder whose pid is still alive just because its epoch field is garbage),
# not toward "ancient" (which would steal from a live holder on bad data).
_maple_clamp_age() { local a="$1"; [ "$a" -lt 0 ] && a=0; printf '%s' "$a"; }

_maple_lock_is_stale() {
  local pid epoch age
  pid="$(_maple_lock_pid)"
  if [ -n "$pid" ]; then
    epoch="$(_maple_lock_epoch)"
    case "$epoch" in
      ''|*[!0-9]*) epoch="$(_maple_now)" ;;  # m6: corrupted epoch -> treat as fresh, never steal a live holder on bad data
    esac
    age="$(_maple_clamp_age $(( $(_maple_now) - epoch )))"
    if _maple_pid_alive "$pid" && [ "$age" -lt "$MAPLE_LOCK_TTL" ]; then
      return 1   # live + fresh -> not stale
    fi
    return 0     # dead, or past TTL -> stale
  fi
  # No meta yet — judge by the lock DIRECTORY's age, not an assumed-zero epoch.
  age="$(_maple_clamp_age $(( $(_maple_now) - $(_maple_dir_mtime "$MAPLE_LOCK_DIR") )))"
  [ "$age" -ge "$MAPLE_LOCK_TTL" ]
}

maple_lock_acquire() {
  local slug="${1:-?}" waited=0 next_progress=0
  while true; do
    if mkdir "$MAPLE_LOCK_DIR" 2>/dev/null; then
      _maple_lock_meta "$slug"
      maple_ok "acquired land lock (slug=$slug)"
      return 0
    fi
    if _maple_lock_is_stale; then
      maple_warn "stealing stale land lock (holder pid=$(_maple_lock_pid) slug=$(_maple_lock_slug))"
      rm -rf "$MAPLE_LOCK_DIR" 2>/dev/null || true
      continue
    fi
    [ "$waited" -lt "$MAPLE_LOCK_WAIT" ] \
      || maple_die "timed out after ${MAPLE_LOCK_WAIT}s waiting for the land lock (held by slug=$(_maple_lock_slug) pid=$(_maple_lock_pid))."
    # Progress line at the start, then roughly every 30s — a silent multi-
    # minute wait looks identical to a hang from the caller's side (and a
    # Claude Code Bash call has its own timeout that can fire first).
    if [ "$waited" -ge "$next_progress" ]; then
      maple_log "land lock held by slug=$(_maple_lock_slug) — queueing (waited ${waited}s/${MAPLE_LOCK_WAIT}s, polls every ${MAPLE_LOCK_POLL}s)…"
      next_progress=$(( waited + 30 ))
    fi
    sleep "$MAPLE_LOCK_POLL"
    waited=$(( waited + MAPLE_LOCK_POLL ))
  done
}

# Release only if WE hold it (don't clobber a holder that stole after a TTL).
maple_lock_release() {
  if [ -d "$MAPLE_LOCK_DIR" ] && [ "$(_maple_lock_pid)" = "$$" ]; then
    rm -rf "$MAPLE_LOCK_DIR" 2>/dev/null || true
    maple_log "released land lock"
  fi
}
