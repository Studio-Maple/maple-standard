#!/usr/bin/env node
// PreToolUse hook for Bash — three deterministic guards for shared-shell hazards.
// Part of the maple-standard plugin (plugin/hooks/hooks.json). Ported +
// generalized from VeHagita's .claude/hooks/bash-guard.mjs.
//
// Exit code 2 signals "block this tool invocation". Exit 0 = allow.
//
// Guard 1 (cwd): the Bash tool's working directory persists across calls,
// including PARALLEL calls in one message — a package-manager command
// without its own absolute `cd` can silently run in a sibling workspace.
// Scoped to mutating, cwd-fragile invocations (npm/npx/yarn/pnpm) so
// git/cat/etc. stay unguarded and noise stays near zero.
//
// Guard 2 (push): a project's pre-push gate can reliably outlive the
// 2-minute default tool timeout — a foreground `git push` gets SIGTERM'd
// mid-gate. Require run_in_background (preferred) or an explicit timeout
// above the configured minimum. Off by default assumption of WHICH gate
// runs (that's project-specific); only the existence of *some* slow gate is
// assumed, and even that is configurable off.
//
// maple.config.json keys (all optional):
//   hooks.bashGuard.cwdGuardEnabled        default true
//   hooks.bashGuard.pushGuardEnabled       default true
//   hooks.bashGuard.pushGuardMinTimeoutMs  default 600000 (10 min)
//   hooks.bashGuard.cleanGuardEnabled      default true
//
// PROJECT ROOT for config lookup: the hook payload's own `cwd` field
// (falling back to $CLAUDE_PROJECT_DIR, then process.cwd()) — not this
// script's own location, which lives under the plugin's install directory.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

function loadMapleConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'maple.config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const ABS_CD = /(?:^|&&|\|\||;)\s*cd\s+(?:"?\/[a-z]\/|"?[A-Za-z]:[\\/]|"?\/(?:home|tmp|mnt|Users)\b)/;
const ABS_PREFIX = /--prefix[= ]+"?(?:\/[a-z]\/|[A-Za-z]:[\\/])/;
const PKG_MANAGER = /(?:^|&&|\|\||;|\$\()\s*(?:npm|npx|yarn|pnpm)\s/;
const GIT_PUSH = /(?:^|&&|\|\||;)\s*git\s+push\b/;
const DEFAULT_PUSH_MIN_TIMEOUT_MS = 600_000;

// Guard 3 (clean): `git clean` with DOUBLE force. Single `-f` is fine and
// common; the second `-f` is the specific flag that makes git delete nested
// git repositories — which, since worktrees moved inside the repo
// (worktrees.root defaults to `.worktrees`), means the parallel-session
// worktrees themselves. Verified in a sandbox: `git clean -xfd` prints
// "Skipping repository .worktrees/foo" and leaves it alone, while
// `git clean -xffd` prints "Removing .worktrees/" and takes the lot.
//
// Why that is worse than losing a worktree: a worktree carries node_modules
// (and .next) JUNCTIONS pointing at the MAIN checkout's real directories, and
// a recursive delete follows them — the exact mechanism behind D012, which
// gutted a main tree's node_modules three times in three days. The sibling
// `<repo>-wt` layout put this out of git's reach; the in-repo layout does not.
// So the hazard is new as of that move, and this guard is its mechanism.
const GIT_CLEAN = /(?:^|&&|\|\||;|\$\()\s*git\s+clean\b([^&|;)]*)/g;

// Count force flags in one `git clean` argument string: each `--force`, plus
// every `f` inside a short-flag cluster (`-xffd` is two, `-f -f` is two).
// Stops at `--` so a literal pathspec like `-- ff.txt` is not miscounted.
function countForce(args) {
  const upToDoubleDash = args.split(/\s--\s/)[0];
  let n = 0;
  for (const m of upToDoubleDash.matchAll(/(?:^|\s)(--force\b|-[A-Za-z]+)/g)) {
    const flag = m[1];
    if (flag === '--force') n += 1;
    else n += (flag.slice(1).match(/f/g) || []).length;
  }
  return n;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Can't parse — allow through (hook errors must not break tool routing).
    process.exit(0);
  }

  const input = payload?.tool_input ?? payload?.input ?? {};
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command) process.exit(0);

  const root = payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cfg = loadMapleConfig(root)?.hooks?.bashGuard ?? {};
  const cwdGuardEnabled = cfg.cwdGuardEnabled !== false;
  const pushGuardEnabled = cfg.pushGuardEnabled !== false;
  const cleanGuardEnabled = cfg.cleanGuardEnabled !== false;
  const pushMinTimeoutMs = Number(cfg.pushGuardMinTimeoutMs) || DEFAULT_PUSH_MIN_TIMEOUT_MS;

  if (cwdGuardEnabled && PKG_MANAGER.test(command) && !ABS_CD.test(command) && !ABS_PREFIX.test(command)) {
    process.stderr.write(
      'BLOCKED (cwd-guard): package-manager commands must anchor their own directory — ' +
      'the shell cwd persists across calls (parallel calls included) and may not be where you think. ' +
      'Re-issue as `cd <absolute path> && ' + command.slice(0, 60).trim() + ' …`.\n',
    );
    process.exit(2);
  }

  if (cleanGuardEnabled) {
    GIT_CLEAN.lastIndex = 0; // module-level /g regex — reset before reuse
    for (const m of command.matchAll(GIT_CLEAN)) {
      if (countForce(m[1] || '') < 2) continue;
      process.stderr.write(
        'BLOCKED (clean-guard): `git clean` with double force (-ff / --force --force) ' +
        'deletes NESTED GIT REPOSITORIES — which now means this repo\'s parallel-session ' +
        'worktrees, since worktrees.root moved inside the repo (default `.worktrees`).\n' +
        '  Verified: `git clean -xfd` prints "Skipping repository .worktrees/<slug>" and is safe. ' +
        '`git clean -xffd` prints "Removing .worktrees/" and takes every worktree with it.\n' +
        '  Worse, a worktree holds node_modules/.next JUNCTIONS into the MAIN checkout\'s real ' +
        'directories and the recursive delete follows them — that is exactly how D012 gutted a ' +
        'main tree three times in three days.\n' +
        '  Drop one -f. If you truly need to remove a worktree, use `git worktree remove` (which ' +
        'the standard wraps with reparse-point stripping) or `/wt-reap`. ' +
        '(Disable via maple.config.json hooks.bashGuard.cleanGuardEnabled=false.)\n',
      );
      process.exit(2);
    }
  }

  if (pushGuardEnabled && GIT_PUSH.test(command)) {
    const inBackground = input.run_in_background === true;
    const timeoutOk = typeof input.timeout === 'number' && input.timeout >= pushMinTimeoutMs;
    if (!inBackground && !timeoutOk) {
      process.stderr.write(
        `BLOCKED (push-guard): this project's pre-push gate can reliably outlive the 2-minute ` +
        `default timeout and the push gets killed mid-gate. Re-issue with run_in_background: true ` +
        `(preferred — you are notified on completion) or timeout: ${pushMinTimeoutMs}. ` +
        `(Disable via maple.config.json hooks.bashGuard.pushGuardEnabled=false if this project's ` +
        `push has no slow gate.)\n`,
      );
      process.exit(2);
    }
  }

  process.exit(0);
});
