// Stop hook — lists uncommitted code changes so a session never silently
// ends with dirty, unpushed work. Non-blocking (always exit 0); it's a
// nudge, not a gate.
const { execSync } = require('child_process');
try {
  const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
  if (!status) process.exit(0);

  const codeFiles = status.split('\n').filter(l => /\.(ts|tsx|js|jsx|sql|css)$/.test(l));
  if (codeFiles.length > 0) {
    console.error('UNCOMMITTED CODE CHANGES:\n' + codeFiles.map(l => '  ' + l).join('\n'));
  }
} catch {}
