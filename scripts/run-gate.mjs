#!/usr/bin/env node
// Runs scripts/ci-local.sh under a REAL bash (D066: one runner). `bash` on a Windows PATH can resolve to WSL's
// System32\bash.exe, which sees a different filesystem and fails in confusing ways; here, on Windows, Git Bash
// is found explicitly and WSL is never used. The lookup lives in ONE place - the plugin's
// scripts/gate/find-bash.mjs - and is imported from the plugin dir (this repo's ./plugin, else a consumer's
// installed plugin; same resolution as ci-local.sh). Usage: node scripts/run-gate.mjs <fast|gate|heavy> [args...]
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIND_BASH = join("scripts", "gate", "find-bash.mjs");

/** First plugin dir that has find-bash.mjs: $MAPLE_PLUGIN_DIR, ./plugin, $CLAUDE_PLUGIN_ROOT, newest installed cache copy. */
export function pluginDir(env = process.env, root = join(HERE, "..")) {
  const cache = join(homedir(), ".claude", "plugins", "cache", "maple-standard", "maple-standard");
  let cached = [];
  try {
    cached = readdirSync(cache).map((v) => join(cache, v)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  } catch { /* no installed plugin */ }
  return [env.MAPLE_PLUGIN_DIR, join(root, "plugin"), env.CLAUDE_PLUGIN_ROOT, ...cached]
    .find((d) => d && existsSync(join(d, FIND_BASH)));
}

function main() {
  const dir = pluginDir();
  if (!dir) {
    console.error("run-gate: the maple-standard plugin (scripts/gate/find-bash.mjs) was not found. Set MAPLE_PLUGIN_DIR or install the plugin.");
    process.exit(2);
  }
  return import(pathToFileURL(join(dir, FIND_BASH)).href).then(({ findBash }) => {
    let bash;
    try {
      bash = findBash();
    } catch (e) {
      console.error(`run-gate: ${e.message}`);
      process.exit(2);
    }
    const script = join(HERE, "ci-local.sh").replaceAll("\\", "/");
    const r = spawnSync(bash, [script, ...process.argv.slice(2)], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
