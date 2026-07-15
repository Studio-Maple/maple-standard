// PostToolUse hook (Edit|Write) — per-layer line-count nudge. Mirrors the
// eslint `max-lines` caps in eslint.config.mjs; this hook just surfaces the
// warning immediately after the edit instead of waiting for the next lint
// run. Adjust the globs here if you rename src/ layers.
let f = '';
try {
  f = JSON.parse(require('fs').readFileSync(0, 'utf8')).tool_input.file_path || '';
} catch {
  process.exit(0); // malformed hook payload — fail open, never noise
}

if (!/[/\\]src[/\\]/.test(f)) process.exit(0);
if (!/\.tsx?$/.test(f)) process.exit(0);
if (/[/\\]components[/\\]ui[/\\]/.test(f)) process.exit(0);

let lines;
try {
  lines = require('fs').readFileSync(f, 'utf8').split('\n').length;
} catch {
  process.exit(0); // file gone/unreadable — nothing to warn about
}
let limit, cat;

if (/[/\\]hooks[/\\]/.test(f)) { limit = 250; cat = 'hook'; }
else if (/[/\\]app[/\\]/.test(f)) { limit = 500; cat = 'route/page'; }
else if (/[/\\](services|lib)[/\\]/.test(f)) { limit = 350; cat = 'service/util'; }
else if (f.endsWith('.tsx')) { limit = 300; cat = 'component'; }
else { limit = 350; cat = 'file'; }

if (lines > limit) {
  console.error(`SIZE WARNING: ${f} is ${lines}/${limit} lines (${cat}). Decompose per eslint max-lines rules.`);
}
