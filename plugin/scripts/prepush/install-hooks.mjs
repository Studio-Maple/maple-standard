#!/usr/bin/env node
/**
 * install-hooks.mjs -- make git hooks fail CLOSED in every worktree of this clone.
 *
 * The hole this closes (2026-10-03): husky 9 sets `core.hooksPath` to the
 * RELATIVE `.husky/_`, a directory husky GENERATES (and .gitignore hides) on
 * `npm ci`. `core.hooksPath` lives in the shared .git/config, so it applies to
 * every worktree, but `.husky/_` exists only in checkouts that ran `npm ci`. A
 * worktree that never did has no hooks directory, and git silently runs NO hook:
 * pushes from such worktrees went out with no pre-push gate at all.
 *
 * Fix: an ABSOLUTE hooksPath into the git COMMON dir (`<common>/maple-hooks`),
 * which exists once per clone and is shared by the main checkout and every
 * worktree, present or future. Each file there is a thin stub that runs the
 * committed `.husky/<hook>` of whichever worktree git is running in -- so each
 * branch still brings its own hook logic -- and REFUSES (exit 1) when that file
 * is missing, instead of skipping. No `npm ci` per worktree is needed.
 *
 * Belt and braces: `npm ci` (husky's own `prepare`, or an older branch's) resets
 * core.hooksPath back to the relative `.husky/_`, which happened within an hour of
 * the first install. So the same stubs are also written into `.husky/_` of EVERY
 * worktree (husky's relative path then still lands on a fail-closed stub), and the
 * committed hooks re-run this installer, so the absolute path heals itself.
 *
 * Usage:
 *   node scripts/install-hooks.mjs            install / repair (idempotent; `prepare` runs it)
 *   node scripts/install-hooks.mjs --check    exit 1 unless hooks are installed and correct
 *   node scripts/install-hooks.mjs --quiet    no output on success
 *
 * Canonical copy: maple-standard plugin, plugin/scripts/prepush/install-hooks.mjs.
 * Projects vendor it as scripts/install-hooks.mjs; keep the copies byte-identical.
 * There is deliberately NO bypass (husky's HUSKY=0 is not honoured): see CLAUDE.md "No bypass".
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const CHECK = process.argv.includes("--check");
const QUIET = process.argv.includes("--quiet");
const log = (m) => { if (!QUIET) console.log(m); };

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

let top;
let common;
try {
  top = git("rev-parse", "--show-toplevel");
  common = git("rev-parse", "--path-format=absolute", "--git-common-dir");
} catch {
  // Not a git checkout (a Docker build, a tarball): nothing to install, like husky.
  log("install-hooks: not a git checkout, skipping");
  process.exit(0);
}

const hooksDir = `${common.replace(/\\/g, "/")}/maple-hooks`;

/** Hook names = the committed files in .husky/ of THIS worktree (never the generated `_`). */
function hookNames() {
  const dir = join(top, ".husky");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n !== "_" && statSync(join(dir, n)).isFile());
}

function stub(name) {
  return `#!/bin/sh
# ${name}: maple-hooks stub, written by scripts/install-hooks.mjs. Do not edit.
# Runs this worktree's committed .husky/${name}; REFUSES when it is missing
# (fail closed). Rationale and the incident: scripts/install-hooks.mjs.
# git runs a hook with the working tree root as cwd (a bare repo: the git dir), so
# pwd is the root even when rev-parse --show-toplevel fails (core.bare=true left
# behind by a test, or GIT_DIR exported without a work tree).
# git exports GIT_DIR (and friends) to hooks. Anything the hook runs that creates or
# reconfigures another repo (tests do: git init, git config, git worktree add) would
# then hit THIS repo instead - it left core.bare=true, a "Test" user and a stray
# agent/test branch in the real repository. Drop them; cwd is the worktree root.
for v in $(git rev-parse --local-env-vars 2>/dev/null); do unset "$v"; done
top="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$top" ] || top="$(pwd)"
script="$top/.husky/${name}"
if [ ! -f "$script" ]; then
  echo "maple-hooks: $script is missing - refusing the ${name}." >&2
  echo "  This checkout predates the gate hooks. Rebase onto development, then retry." >&2
  exit 1
fi
PATH="node_modules/.bin:$PATH"
export PATH
sh -e "$script" "$@"
`;
}

const names = hookNames();
if (names.length === 0) {
  console.error("install-hooks: no committed hooks in .husky/ of this checkout - nothing to install");
  process.exit(CHECK ? 1 : 0);
}

const problems = [];
const configured = (() => { try { return git("config", "--get", "core.hooksPath"); } catch { return ""; } })();
if (configured.replace(/\\/g, "/") !== hooksDir) problems.push(`core.hooksPath is "${configured || "(unset)"}", expected ${hooksDir}`);
for (const n of names) {
  const f = join(hooksDir, n);
  if (!existsSync(f) || readFileSync(f, "utf8") !== stub(n)) problems.push(`${f} is missing or out of date`);
}

if (CHECK) {
  if (problems.length > 0) {
    console.error("FAILED: git hooks are not fail-closed in this clone:");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("  fix: node scripts/install-hooks.mjs   (pushes from this clone run NO pre-push gate until then)");
    process.exit(1);
  }
  log(`install-hooks: ok (${names.join(", ")} -> ${hooksDir})`);
  process.exit(0);
}

function writeStubs(dir) {
  mkdirSync(dir, { recursive: true });
  for (const n of names) {
    const f = join(dir, n);
    if (!existsSync(f) || readFileSync(f, "utf8") !== stub(n)) writeFileSync(f, stub(n), { mode: 0o755 });
    try { chmodSync(f, 0o755); } catch { /* Windows */ }
  }
}
writeStubs(hooksDir);

// Every worktree's husky-relative directory gets the same fail-closed stubs.
try {
  for (const line of git("worktree", "list", "--porcelain").split(/\r?\n/)) {
    if (!line.startsWith("worktree ")) continue;
    const wt = resolve(line.slice("worktree ".length));
    if (!existsSync(join(wt, ".husky"))) continue;
    const dir = join(wt, ".husky", "_");
    writeStubs(dir);
    const ig = join(dir, ".gitignore");
    if (!existsSync(ig)) writeFileSync(ig, "*\n");
  }
} catch { /* best effort: the absolute hooksPath is the primary mechanism */ }
if (configured.replace(/\\/g, "/") !== hooksDir) git("config", "core.hooksPath", hooksDir);
log(`install-hooks: ${names.join(", ")} now fail closed in every worktree (core.hooksPath=${hooksDir})`);
