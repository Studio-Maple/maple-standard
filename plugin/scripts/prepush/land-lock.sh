#!/usr/bin/env bash
# land-lock.sh -- the per-target-ref LANDING LOCK as a command, for /wt-land (and
# anything else that lands on a shared branch). Same lock the pre-push hook takes
# (prepush-lib.sh pp_land_*), so a raw `git push` and /wt-land exclude each other.
#
#   land-lock.sh acquire --remote origin --ref refs/heads/development --sha <sha> --pid <owner pid> [--wait <s>] [--no-fresh]
#       blocks (messages on stderr) until the lock is ours, re-checks staleness, then prints
#           export PP_LAND_HOLDER_ID=<id>
#       on stdout: `eval` it so the `git push` you run next (and its pre-push hook) re-enter
#       the lock instead of waiting on you. Exit 1 on timeout or staleness.
#   land-lock.sh release --remote origin --ref refs/heads/development [--id <id>]
#   land-lock.sh status  --remote origin --ref refs/heads/development
#
# The owner pid (--pid) must be a process that lives for the whole landing (the
# calling script's $$); a dead owner frees the lock.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=prepush-lib.sh
. "$HERE/prepush-lib.sh"

cmd="${1:-}"; shift || true
remote="origin"; ref=""; sha=""; pid=""; wait="${MAPLE_LAND_WAIT:-7200}"; id=""; fresh=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --remote) remote="$2"; shift 2 ;;
    --ref) ref="$2"; shift 2 ;;
    --sha) sha="$2"; shift 2 ;;
    --pid) pid="$2"; shift 2 ;;
    --wait) wait="$2"; shift 2 ;;
    --id) id="$2"; shift 2 ;;
    --no-fresh) fresh=0; shift ;;
    *) echo "land-lock: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$ref" ] || { echo "land-lock: --ref is required" >&2; exit 2; }
case "$ref" in refs/*) ;; *) ref="refs/heads/$ref" ;; esac

pp_init "$(git rev-parse --show-toplevel)" ""
_pp_land_dir || { echo "land-lock: not inside a git checkout" >&2; exit 1; }
_pp_land_key "$remote" "$ref"
lock="$PP_LAND_DIR/$PP_LAND_KEYV.lock"

case "$cmd" in
  acquire)
    [ -n "$sha" ] || sha="$(git rev-parse HEAD)"
    kind="msys"; [ -n "$pid" ] || pid="$PPID"
    pp_land_acquire "$remote" "$ref" "$sha" "$wait" "$kind:$pid" >&2 || exit 1
    if [ "$fresh" -eq 1 ] && ! pp_land_fresh_check "$remote" "$ref" "$sha" >&2; then
      rm -rf "$lock" 2>/dev/null; exit 1
    fi
    printf 'export PP_LAND_HOLDER_ID=%q\n' "$PP_LAND_HOLDER_ID"
    ;;
  release)
    if [ -d "$lock" ]; then
      cur=""
      if [ -f "$lock/holder" ]; then while IFS='=' read -r k v; do [ "$k" = id ] && cur="$v"; done <"$lock/holder" || true; fi
      if [ -z "$id" ] || [ "$cur" = "$id" ]; then rm -rf "$lock"; fi
    fi
    ;;
  status)
    if [ -d "$lock" ]; then echo "landing lock on ${ref#refs/heads/}: held by $(_pp_holder_line "$lock")"; else echo "landing lock on ${ref#refs/heads/}: free"; fi
    ;;
  *) echo "usage: land-lock.sh acquire|release|status --ref <ref> [--remote origin] ..." >&2; exit 2 ;;
esac
