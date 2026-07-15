// PostToolUse hook (Edit|Write) — auto-fixes the just-edited file with eslint.
// Single-package repo: no frontend/ subdir indirection — runs from repo root.
let f = '';
try {
  f = JSON.parse(require('fs').readFileSync(0, 'utf8')).tool_input.file_path || '';
} catch {
  process.exit(0); // malformed hook payload — fail open, never noise
}
const path = require('path');

if (!/\.(tsx?|jsx?)$/.test(f)) process.exit(0);
if (/[/\\]node_modules[/\\]/.test(f)) process.exit(0);

// Find the nearest ancestor package.json to use as the eslint cwd (works
// whether Claude Code's cwd is the repo root or a subdirectory).
function findRoot(from) {
  let dir = path.dirname(from);
  for (let i = 0; i < 8; i++) {
    if (require('fs').existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const cwd = findRoot(f);
const eslint = path.join(cwd, 'node_modules', '.bin', 'eslint');

const r = require('child_process').spawnSync(eslint, ['--fix', f], {
  shell: true, stdio: 'pipe', cwd,
});
if (r.status !== 0) {
  console.error('ESLint errors in ' + path.basename(f));
}
