#!/usr/bin/env node
// scripts/run-knip.mjs — runs knip, falling back to a Linux container ONLY
// when Windows Application Control blocks knip's native resolver binding.
//
// Why: knip depends on oxc-resolver, which ships an unsigned native module
// (resolver.win32-x64-msvc.node). On a machine enforcing Windows Application
// Control (WDAC / Smart App Control) the OS refuses to load it —
// "An Application Control policy has blocked this file." — so knip cannot
// start, the fast tier goes red, and the pre-push gate blocks every push.
// That is an environment fault, not a dead-code finding. Skipping the step
// would be a bypass; running the SAME knip in a Linux container, where the
// Linux binding loads normally, keeps the check.
//
// The fallback is deliberately narrow: only an error chain that mentions
// Application Control triggers it. Any other load failure, and every real
// knip finding, fails exactly as before. If Docker is unavailable when the
// fallback is needed, this fails loud rather than passing.
//
// Container details: node:24-bookworm, repo bind-mounted at /repo, with a
// per-repo named volume over node_modules so the container installs Linux
// binaries without touching the host's Windows install (and reuses them on
// the next run). Args are forwarded to knip in both paths.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function errorText(e, seen = new Set()) {
  if (!e || typeof e !== 'object' || seen.has(e)) return String(e ?? '');
  seen.add(e);
  if (Array.isArray(e)) return e.map((x) => errorText(x, seen)).join('\n');
  return [e.message, e.code, errorText(e.cause, seen)].filter(Boolean).join('\n');
}

function nativeBindingBlocked() {
  if (process.env.KNIP_FORCE_CONTAINER === '1') return true; // exercise the fallback path on purpose
  // oxc-resolver is knip's dependency, not ours: resolve it from knip's REAL
  // directory. Not via require.resolve('knip/package.json') — knip's `exports`
  // map hides that subpath, the throw lands in the catch below, and the probe
  // silently reports "not blocked" on every machine.
  let fromKnip;
  try {
    fromKnip = createRequire(path.join(realpathSync(path.join(root, 'node_modules', 'knip')), 'package.json'));
  } catch {
    return false; // knip not installed — let `pnpm exec knip` report that plainly
  }
  try {
    fromKnip('oxc-resolver');
    return false;
  } catch (e) {
    return /application control/i.test(errorText(e));
  }
}

// Only pnpm needs a shell on Windows (it is pnpm.cmd). docker.exe does not,
// and must not get one: cmd.exe would mangle the bash -c payload's quoting.
function run(cmd, cmdArgs) {
  const shell = process.platform === 'win32' && cmd === 'pnpm';
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: 'inherit', shell });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

if (!nativeBindingBlocked()) {
  process.exit(run('pnpm', ['exec', 'knip', ...args]));
}

console.log(
  process.env.KNIP_FORCE_CONTAINER === '1'
    ? 'knip: KNIP_FORCE_CONTAINER=1 — running knip in a Linux container.'
    : "knip: Windows Application Control blocks oxc-resolver's native binding on this machine —\n" +
        '      running the same knip in a Linux container instead (see scripts/run-knip.mjs).',
);

if (run('docker', ['info', '--format', '{{.ServerVersion}}']) !== 0) {
  console.error('x knip cannot run: its native binding is blocked AND Docker is not available.');
  console.error('  Start Docker Desktop, or allow resolver.win32-x64-msvc.node in Application Control.');
  process.exit(1);
}

const volume = `knip-nm-${createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 12)}`;
const quoted = args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
const inner =
  'corepack enable >/dev/null && ' +
  '(pnpm install --frozen-lockfile >/tmp/install.log 2>&1 || { tail -30 /tmp/install.log; exit 1; }) && ' +
  `pnpm exec knip ${quoted}`;

process.exit(
  run('docker', [
    'run', '--rm',
    '-e', 'HUSKY=0', '-e', 'CI=true',
    // Keep pnpm's store inside the node_modules volume. Left to default, it
    // lands in /repo/.pnpm-store — i.e. a cache dir written into the host repo.
    '-e', 'npm_config_store_dir=/repo/node_modules/.pnpm-store',
    '-v', `${root}:/repo`,
    '-v', `${volume}:/repo/node_modules`,
    '-w', '/repo',
    'node:24-bookworm',
    'bash', '-c', inner,
  ]),
);
