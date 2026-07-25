#!/usr/bin/env node
// Stop hook — lists uncommitted code changes so a session never silently
// ends with dirty, unpushed work. Non-blocking (always exit 0); it's a
// nudge, not a gate. Part of the maple-standard plugin (plugin/hooks/hooks.json).
const { execSync } = require('child_process');
const { readFileSync } = require('fs');

function readStdinPayload() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

try {
  const payload = readStdinPayload();
  // PROJECT ROOT: the hook payload's own `cwd` field (falling back to
  // $CLAUDE_PROJECT_DIR, then process.cwd()) — a plugin hook script lives
  // under the plugin's install directory, not the adopting project, so it
  // can't assume its own cwd without this resolution.
  const root = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const status = execSync('git status --porcelain', { cwd: root, encoding: 'utf8' }).trim();
  if (!status) process.exit(0);

  const codeFiles = status.split('\n').filter(l => /\.(ts|tsx|js|jsx|mjs|cjs|sql|css)$/.test(l));
  if (codeFiles.length > 0) {
    console.error('UNCOMMITTED CODE CHANGES:\n' + codeFiles.map(l => '  ' + l).join('\n'));
  }
} catch {}
process.exit(0);
