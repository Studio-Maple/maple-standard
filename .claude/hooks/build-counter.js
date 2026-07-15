// PostToolUse hook (Edit|Write) — every 5th edit to a TS file in this repo
// runs `tsc --noEmit` and surfaces the first errors immediately, instead of
// waiting for the fast-tier gate to catch a type error several edits later.
let f = '';
try {
  f = JSON.parse(require('fs').readFileSync(0, 'utf8')).tool_input.file_path || '';
} catch {
  process.exit(0); // malformed hook payload — fail open, never noise
}
const path = require('path');
const fs = require('fs');
const os = require('os');

if (!/[/\\]src[/\\]/.test(f)) process.exit(0);
if (!/\.tsx?$/.test(f)) process.exit(0);

function findRoot(from) {
  let dir = path.dirname(from);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

const counterFile = path.join(os.tmpdir(), 'maple-standard-edit-counter');
let count = 0;
try { count = parseInt(fs.readFileSync(counterFile, 'utf8')) || 0; } catch {}
count++;

if (count >= 5) {
  fs.writeFileSync(counterFile, '0');
  const cwd = findRoot(f);
  const tsc = path.join(cwd, 'node_modules', '.bin', 'tsc');
  const r = require('child_process').spawnSync(tsc, ['--noEmit', '--pretty'], {
    shell: true, stdio: 'pipe', cwd, timeout: 40000,
  });
  if (r.status !== 0) {
    const output = (r.stdout ? r.stdout.toString() : '').slice(0, 500);
    console.error('TYPE CHECK FAILED after 5 edits:\n' + output);
  }
} else {
  fs.writeFileSync(counterFile, count.toString());
}
