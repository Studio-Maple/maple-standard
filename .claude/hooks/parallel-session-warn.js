// SessionStart WARN (default-on, opt-out). If parallel agent worktrees are
// active alongside THIS session's shared main checkout, nudge toward
// isolation — committing in the shared tree stages the whole index and can
// collide with another session's work. A session already inside a linked
// worktree needs no nudge.
//
// Generalized from the reference codebase's pattern (which hardcoded a branch name
// and a worktree-directory naming convention specific to that repo) — this
// version works for any branch/worktree-naming scheme.
//
// Warning only — never blocks. Silence with: MAPLE_PARALLEL_WARN=off
const { execSync } = require('child_process');
const sh = (c) => { try { return execSync(c, { encoding: 'utf8' }).trim(); } catch { return ''; } };

try {
  if (/^(off|0|false)$/i.test(process.env.MAPLE_PARALLEL_WARN || '')) process.exit(0);

  // Linked worktrees report a git-dir under .git/worktrees/<name>; the main
  // checkout reports plain .git. A session already isolated needs no nudge.
  if (/[\\/]worktrees[\\/]/.test(sh('git rev-parse --absolute-git-dir'))) process.exit(0);

  const worktreeList = sh('git worktree list').split('\n').filter(Boolean);
  // First line is always the main checkout; anything beyond it is a linked
  // worktree — likely another parallel agent session.
  const linkedCount = Math.max(0, worktreeList.length - 1);
  if (linkedCount === 0) process.exit(0);

  console.error(
    `⚠ ${linkedCount} parallel git worktree(s) active — you're in the SHARED main tree.\n` +
    `  Commits here stage the whole index and can collide with another session's work.\n` +
    `  Consider scoping commits (\`git commit -- <paths>\`) or isolating with \`git worktree add\`.\n` +
    `  (warning only; silence with MAPLE_PARALLEL_WARN=off)`
  );
} catch {}
process.exit(0);
