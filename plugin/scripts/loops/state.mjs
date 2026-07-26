#!/usr/bin/env node
/**
 * state.mjs (loop pack, docs/tasks.md #T8) — plain-JS helper for each loop's
 * per-loop state file: `.loop-state/<loop>.json` (docs/loop-pack.md's
 * per-loop "State persistence" column — fingerprint/task/commit cursors,
 * outcomes, cooldown timestamps). The exact JSON shape inside the file is
 * loop-specific and owned by that loop's command file (plugin/commands/
 * sweep-errors.md etc.) — this module only knows how to read/write it
 * safely, never what's inside.
 *
 * Atomic write (tmp file + rename — rename is atomic on the same filesystem
 * on every platform this runs on, including Windows NTFS) so a crash
 * mid-write never leaves a truncated/corrupt JSON file behind. Tolerant
 * read: a missing file starts fresh silently (expected on first run); a
 * corrupt/unreadable file starts fresh WITH a warning — never throws. A
 * loop cycle should never die because its own bookkeeping file got mangled;
 * that's the whole point of "the worker never grades its own homework" (D007)
 * not becoming "the worker crashes because its scratch file is stale."
 *
 * All paths resolve relative to a `root` — the checkout the caller is
 * running in (CLAUDE_PROJECT_DIR or cwd by default, same convention as
 * plugin/scripts/validate-config.mjs and plugin/scripts/docs/lib/config.mjs).
 * For the loop pack that's the standing dev-burner worktree once
 * /dev-burner has entered it — see docs/loop-pack.md "Standing execution
 * model". `.loop-state/` itself must be gitignored (plugin/commands/
 * dev-burner.md instructs adding it on first run if absent — this module
 * never touches .gitignore itself).
 *
 * Importable:
 *   loopStateDir(root) -> "<root>/.loop-state"
 *   loopStateFilePath(root, loop) -> "<root>/.loop-state/<loop>.json"
 *   readLoopState(root, loop, { defaultState }) -> { state, recovered, warning }
 *   writeLoopState(root, loop, state) -> absolute path written
 *
 * CLI:
 *   node state.mjs read <loop> [--root <path>]     -> JSON to stdout
 *   node state.mjs write <loop> [--root <path>]    <- JSON on stdin
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function loopStateDir(root) {
  return join(root, ".loop-state");
}

export function loopStateFilePath(root, loop) {
  return join(loopStateDir(root), `${loop}.json`);
}

/**
 * @param {string} root
 * @param {string} loop
 * @param {{defaultState?: object}} [opts]
 * @returns {{state: object, recovered: boolean, warning: string|null}}
 *   recovered=true means the file existed but was unreadable/corrupt and a
 *   fresh default was substituted in its place — callers should surface
 *   `warning` (e.g. print to stderr / fold into the cycle report).
 */
export function readLoopState(root, loop, { defaultState = {} } = {}) {
  const file = loopStateFilePath(root, loop);
  if (!existsSync(file)) {
    return { state: structuredClone(defaultState), recovered: false, warning: null };
  }
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("state file root must be a JSON object");
    }
    return { state: parsed, recovered: false, warning: null };
  } catch (e) {
    const warning = `${file}: corrupt/unreadable state (${e.message}) — starting fresh`;
    return { state: structuredClone(defaultState), recovered: true, warning };
  }
}

/** Atomic write: write a tmp file in the SAME directory, then rename over
 * the real path. Leaves no tmp file behind on success. */
export function writeLoopState(root, loop, state) {
  const dir = loopStateDir(root);
  mkdirSync(dir, { recursive: true });
  const file = loopStateFilePath(root, loop);
  const tmp = join(dir, `.${loop}.json.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
  return file;
}

/** Used only by tests wanting to assert no stray tmp files survive a write. */
export function listStateDir(root) {
  const dir = loopStateDir(root);
  return existsSync(dir) ? readdirSync(dir) : [];
}

// ---- CLI --------------------------------------------------------------------

function defaultRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function parseRoot(argv) {
  const i = argv.indexOf("--root");
  return i !== -1 ? argv[i + 1] : defaultRoot();
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function main() {
  const [cmd, loop, ...rest] = process.argv.slice(2);
  const root = parseRoot(rest);
  if (!cmd || !loop || (cmd !== "read" && cmd !== "write")) {
    console.error("Usage: node state.mjs read|write <loop> [--root <path>]  (write reads JSON from stdin)");
    process.exit(1);
  }
  if (cmd === "read") {
    const { state, warning } = readLoopState(root, loop);
    if (warning) console.error(`[state] ${warning}`);
    process.stdout.write(JSON.stringify(state));
    process.exit(0);
  } else {
    const raw = readStdin();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(`[state] invalid JSON on stdin: ${e.message}`);
      process.exit(1);
    }
    const file = writeLoopState(root, loop, parsed);
    console.log(`OK — wrote ${file}`);
    process.exit(0);
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  return import.meta.url === argvUrl;
}

if (isMain()) {
  main();
}
