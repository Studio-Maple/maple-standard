#!/usr/bin/env node
// SessionStart WARN (default-on, opt-out). If parallel agent worktrees are
// active alongside THIS session's shared main checkout, nudge toward
// isolation — committing in the shared tree stages the whole index and can
// collide with another session's work. A session already inside a linked
// worktree needs no nudge. Part of the maple-standard plugin
// (plugin/hooks/hooks.json).
//
// Warning only — never blocks. Silence with: MAPLE_PARALLEL_WARN=off
//
// PROJECT ROOT: the hook payload's own `cwd` field (falling back to
// $CLAUDE_PROJECT_DIR, then process.cwd()) — not __dirname, which resolves
// inside the plugin's install directory, not the adopting project.
const { execSync } = require('child_process');
const { readFileSync } = require('fs');

function readStdinPayload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

const sh = (c, cwd) => { try { return execSync(c, { cwd, encoding: 'utf8' }).trim(); } catch { return ''; } };

try {
  if (/^(off|0|false)$/i.test(process.env.MAPLE_PARALLEL_WARN || '')) process.exit(0);

  const payload = readStdinPayload();
  const root = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Linked worktrees report a git-dir under .git/worktrees/<name>; the main
  // checkout reports plain .git. A session already isolated needs no nudge.
  if (/[\\/]worktrees[\\/]/.test(sh('git rev-parse --absolute-git-dir', root))) process.exit(0);

  const worktreeList = sh('git worktree list', root).split('\n').filter(Boolean);
  // First line is always the main checkout; anything beyond it is a linked
  // worktree — likely another parallel agent session.
  const linkedCount = Math.max(0, worktreeList.length - 1);
  if (linkedCount === 0) process.exit(0);

  console.error(
    `⚠ ${linkedCount} parallel git worktree(s) active — you're in the SHARED main tree.\n` +
    `  Commits here stage the whole index and can collide with another session's work.\n` +
    `  Consider scoping commits (\`git commit -- <paths>\`) or isolating with \`/wt-start <slug>\`.\n` +
    `  (warning only; silence with MAPLE_PARALLEL_WARN=off)`
  );
} catch {}
process.exit(0);
