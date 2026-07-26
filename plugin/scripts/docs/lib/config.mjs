#!/usr/bin/env node
/**
 * config.mjs — shared `maple.config.json` `docs.*` resolver for the bundled
 * docs tooling (check-docs-drift.mjs, generate-docs-index.mjs,
 * next-task-id.mjs, doc-search/search.mjs — docs/tasks.md #T13).
 *
 * Reads the canonical `docs.*` keys as documented in
 * docs/standard-architecture.md's `maple.config.json` schema: root, index,
 * tasks, decisions, log, gaps, docsIndexJson. Defaults match this
 * template's own flat docs/ layout, so every script under
 * plugin/scripts/docs/ works unmodified in a project with NO
 * maple.config.json at all.
 *
 * The plugin's own hooks (plugin/hooks/ask-gate.mjs, docs-sync-reminder.js,
 * decision-reminder.js) read this SAME canonical key set now (reconciled
 * docs/tasks.md #T11/#T12 — they used to ship their own older
 * decisionsFile/tasksFile/gapsFile/indexFile/changelogFile/searchScript/
 * idAllocatorScript names; retired, one key set, no aliases). ask-gate.mjs
 * imports this module directly (both are ESM); the two CommonJS hooks
 * (decision-reminder.js, docs-sync-reminder.js) mirror this module's
 * defaults/lookup order inline rather than bridging module systems with an
 * async import().
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function loadMapleConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, "maple.config.json"), "utf8"));
  } catch {
    return {};
  }
}

export const DOCS_DEFAULTS = {
  root: "docs",
  index: "docs/index.md",
  tasks: "docs/tasks.md",
  decisions: "docs/decisions.md",
  log: "docs/log.md",
  gaps: "docs/gaps.md",
  docsIndexJson: "docs/.docs-index.json",
};

/**
 * Resolve every docs.* path to an ABSOLUTE path.
 * @param {string} root project root
 * @param {object} [env] test-only override source — mirrors next-task-id.mjs's
 *   pre-existing NEXT_TASK_ID_{TASKS,DECISIONS,LOG}_FILE convention so its
 *   fixtures keep working after delegation.
 */
export function resolveDocsConfig(root, env = process.env) {
  const cfg = loadMapleConfig(root)?.docs ?? {};
  const pick = (key, envKey) => resolve(root, (envKey && env[envKey]) || cfg[key] || DOCS_DEFAULTS[key]);
  return {
    root: pick("root"),
    index: pick("index"),
    tasks: pick("tasks", "NEXT_TASK_ID_TASKS_FILE"),
    decisions: pick("decisions", "NEXT_TASK_ID_DECISIONS_FILE"),
    log: pick("log", "NEXT_TASK_ID_LOG_FILE"),
    gaps: pick("gaps"),
    docsIndexJson: pick("docsIndexJson"),
  };
}

/** Default project-root resolution shared by every bundled docs script's CLI entry. */
export function defaultRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
