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
 * NOTE — known inconsistency, not introduced here: the plugin's existing
 * hooks (plugin/hooks/ask-gate.mjs, docs-sync-reminder.js,
 * decision-reminder.js) already ship reading a DIFFERENT, older set of
 * docs.* key names (decisionsFile/tasksFile/gapsFile/indexFile/
 * changelogFile/searchScript/idAllocatorScript), documented in
 * plugin/README.md. That table predates docs/standard-architecture.md's
 * schema and the two have drifted apart. This module intentionally follows
 * the canonical schema (root/index/tasks/decisions/log/gaps/docsIndexJson)
 * per this task's brief; reconciling the hooks' key names is out of scope
 * here — see plugin/README.md "Gaps".
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
