#!/usr/bin/env node
/**
 * check-hook-wiring.mjs — fast-tier check (D065): hooks live ONLY in the plugin.
 *
 * Fails when a project's `.claude/settings*.json` registers a hook command whose script basename matches
 * a plugin hook (guard.mjs, scrub-secrets.mjs, jev-validate-subagent.mjs, or any module under
 * plugin/hooks/guards/) or one of the REMOVED hooks (eslint-fix, size-warning, build-counter, ask-gate,
 * dirty-tree-guard, docs-sync-reminder, decision-reminder, parallel-session-warn), or points at a
 * relative `node .claude/hooks/...` path. Also fails when such a file still sits in `.claude/hooks/`
 * (a stale copy would be re-registered by the next copy/paste). A project's own, differently named hook
 * script is not touched here.
 *
 * Usage: node plugin/scripts/hooks/check-hook-wiring.mjs [--root <project dir>]
 * Exit 0 = clean, 1 = violations (listed), 2 = usage error.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_HOOKS = join(HERE, "..", "..", "hooks");

export const REMOVED_HOOKS = [
  "eslint-fix", "size-warning", "build-counter", "ask-gate", "dirty-tree-guard", "docs-sync-reminder", "decision-reminder", "parallel-session-warn",
];

const HELPERS = new Set(["shell", "project"]); // guard-internal helper modules, not hooks
const stem = (file) => basename(file).replace(/\.(mjs|cjs|js|sh|ps1)$/i, "");

/** Basenames (without extension) of every hook the plugin ships, plus the removed ones. */
export function pluginHookNames() {
  const names = new Set(REMOVED_HOOKS);
  for (const dir of [PLUGIN_HOOKS, join(PLUGIN_HOOKS, "guards")]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (/\.(mjs|cjs|js)$/.test(f) && !/\.test\./.test(f) && !HELPERS.has(stem(f))) names.add(stem(f));
  }
  return names;
}

function commandsOf(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => commandsOf(n, out));
  else if (node && typeof node === "object") {
    if (typeof node.command === "string") out.push([node.command, ...(Array.isArray(node.args) ? node.args.filter((a) => typeof a === "string") : [])].join(" "));
    for (const v of Object.values(node)) commandsOf(v, out);
  }
  return out;
}

/** @returns {string[]} human-readable violations for the project at `root`. */
export function checkWiring(root) {
  const names = pluginHookNames();
  const problems = [];
  const claudeDir = join(root, ".claude");
  if (!existsSync(claudeDir)) return problems;
  for (const f of readdirSync(claudeDir).filter((x) => /^settings.*\.json$/.test(x)).sort()) {
    let json;
    try {
      json = JSON.parse(readFileSync(join(claudeDir, f), "utf8"));
    } catch {
      problems.push(`.claude/${f}: not valid JSON, cannot check its hooks`);
      continue;
    }
    for (const command of commandsOf(json.hooks ?? {})) {
      for (const m of command.matchAll(/[^\s"'=]*?([\w.-]+\.(?:mjs|cjs|js|sh|ps1))/g)) {
        if (names.has(stem(m[1]))) problems.push(`.claude/${f}: registers "${m[1]}", which the plugin already provides (D065: hooks live only in the plugin) — delete the entry`);
      }
      if (/(^|[\s"'])(\.\/)?\.claude[\\/]hooks[\\/]/.test(command)) {
        problems.push(`.claude/${f}: relative project-hook path in "${command.slice(0, 80)}" (D065: no project copies of hooks; plugin hooks need no registration)`);
      }
    }
  }
  const hooksDir = join(claudeDir, "hooks");
  if (existsSync(hooksDir)) {
    for (const f of readdirSync(hooksDir)) {
      if (names.has(stem(f))) problems.push(`.claude/hooks/${f}: stale copy of a plugin/removed hook (D065) — delete the file`);
    }
  }
  return problems;
}

function main(argv) {
  const i = argv.indexOf("--root");
  if (i >= 0 && !argv[i + 1]) { console.error("usage: check-hook-wiring.mjs [--root <project dir>]"); return 2; }
  const root = resolve(i >= 0 ? argv[i + 1] : process.cwd());
  const problems = checkWiring(root);
  if (problems.length === 0) { console.log("hook-wiring: ok (no project hook duplicates the plugin)"); return 0; }
  console.error("hook-wiring: FAILED");
  for (const p of problems) console.error(`  - ${p}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
