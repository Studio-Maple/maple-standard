// D066: the land lock is NEVER taken from a live pid. It used to be stolen once older than a TTL (default 900 s) while
// real gates run 11-95 minutes. Also: the sandbox-safe sleep (maple_sleep) still waits when /usr/bin/sleep is denied.
// Pure functions of maple-lib.sh against a throwaway repo (no worktrees, no gate) - fast.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "maple-lib.sh").replace(/\\/g, "/");
const base = realpathSync(mkdtempSync(join(tmpdir(), "maple-lock-")));
const repo = join(base, "repo");
mkdirSync(repo);
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: repo, encoding: "utf8", ...opts });
sh("git", ["init", "-q"]); sh("git", ["config", "user.email", "t@t"]); sh("git", ["config", "user.name", "t"]);
writeFileSync(join(repo, "a"), "a"); sh("git", ["add", "-A"]); sh("git", ["commit", "-q", "-m", "c"]);

/** run a bash snippet with maple-lib sourced inside the temp repo; returns trimmed stdout */
const run = (snippet, env = {}) => {
  const r = sh("bash", ["-c", `set -euo pipefail; . "${LIB}"; ${snippet}`], { env: { ...process.env, ...env } });
  return { out: r.stdout.trim(), err: r.stderr, status: r.status };
};
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };

// stale <=> holder dead; helper starts a live background pid, sets up the lock dir, asks the question, kills the pid
const verdict = (setup) => run(`
  MAPLE_LOCK_DIR="$MAPLE_COMMON_DIR/test.lock"; rm -rf "$MAPLE_LOCK_DIR"; mkdir -p "$MAPLE_LOCK_DIR"
  ( while :; do maple_sleep 1; done ) >/dev/null 2>&1 & LIVE=$!
  trap 'kill "$LIVE" 2>/dev/null || true' EXIT
  ${setup}
  if _maple_lock_is_stale; then echo STALE; else echo FRESH; fi
  kill "$LIVE" 2>/dev/null || true
`, { MAPLE_LOCK_GRACE: "120" }).out;

const OLD = "$(( $(date +%s) - 18000 ))"; // five hours ago

t("a lock held by a LIVE pid is not stale however old (the TTL steal is gone)", () => {
  assert.equal(verdict(`printf '%s\\n%s\\n%s\\n' "$LIVE" "${OLD}" slug > "$MAPLE_LOCK_DIR/meta"; touch -d "5 hours ago" "$MAPLE_LOCK_DIR" 2>/dev/null || true`), "FRESH");
});
t("a lock whose holder pid is dead is stale at once", () => {
  assert.equal(verdict(`printf '%s\\n%s\\n%s\\n' 999999 "$(date +%s)" slug > "$MAPLE_LOCK_DIR/meta"`), "STALE");
});
t("a corrupted pid in a young lock is not stale (fail safe)", () => {
  assert.equal(verdict(`printf '%s\\n%s\\n%s\\n' "not-a-pid" "$(date +%s)" slug > "$MAPLE_LOCK_DIR/meta"`), "FRESH");
});
t("a corrupted epoch with a live pid is not stale", () => {
  assert.equal(verdict(`printf '%s\\n%s\\n%s\\n' "$LIVE" "garbage" slug > "$MAPLE_LOCK_DIR/meta"`), "FRESH");
});
t("no meta yet (owner between mkdir and the write): young is kept, old (died before writing) is stale", () => {
  assert.equal(verdict(``), "FRESH");
  assert.equal(verdict(`touch -d "5 hours ago" "$MAPLE_LOCK_DIR" 2>/dev/null || true`), "STALE");
});
t("maple_lock_acquire never steals a live holder: it times out instead", () => {
  const r = run(`
    ( while :; do maple_sleep 1; done ) >/dev/null 2>&1 & LIVE=$!
    trap 'kill "$LIVE" 2>/dev/null || true' EXIT
    mkdir -p "$MAPLE_LOCK_DIR"; printf '%s\\n%s\\n%s\\n' "$LIVE" "$(( $(date +%s) - 18000 ))" holder > "$MAPLE_LOCK_DIR/meta"
    touch -d "5 hours ago" "$MAPLE_LOCK_DIR" 2>/dev/null || true
    MAPLE_LOCK_WAIT=3 MAPLE_LOCK_POLL=1 maple_lock_acquire me || echo "rc=$?"
    kill "$LIVE" 2>/dev/null || true
  `, { MAPLE_LOCK_WAIT: "3", MAPLE_LOCK_POLL: "1" });
  assert.notEqual(r.status, 0, "acquire must give up, not steal");
  assert.match(r.err, /timed out after 3s waiting for the land lock/);
});

// sandbox-safe sleep: stub a `sleep` that is "Permission denied" first on PATH
const deny = join(base, "deny");
mkdirSync(deny);
writeFileSync(join(deny, "sleep"), "#!/bin/sh\necho 'sleep: Permission denied' >&2\nexit 126\n");
chmodSync(join(deny, "sleep"), 0o755);
const denyU = spawnSync("bash", ["-c", `cygpath -u "${deny.replace(/\\/g, "/")}" 2>/dev/null || echo "${deny.replace(/\\/g, "/")}"`], { encoding: "utf8" }).stdout.trim();
t("maple_sleep still waits (read -t over a private fifo) when /usr/bin/sleep is denied", () => {
  const r = run(`
    if command sleep 0 2>/dev/null; then echo STUB_INACTIVE; exit 0; fi
    s=$SECONDS; maple_sleep 2; maple_sleep 1; echo "waited=$((SECONDS - s))"
  `, { PATH: `${denyU}:${process.env.PATH}` });
  if (r.out.includes("STUB_INACTIVE")) { console.log("  (sleep stub not honoured on this platform - skipped)"); return; }
  const m = /waited=(\d+)/.exec(r.out);
  assert.ok(m && Number(m[1]) >= 3 && Number(m[1]) <= 6, "waited ~3s, got: " + r.out + r.err);
});

console.log(`\nall ${n} lock-safety tests passed`);
