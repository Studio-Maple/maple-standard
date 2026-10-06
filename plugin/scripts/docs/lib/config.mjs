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
 * One canonical key set, no aliases.
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
  // docs.changelog: default CHANGELOG.md.
  changelog: "CHANGELOG.md",
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

  // docsIndexJson's default is DERIVED from the effective docs.root instead
  // of the flat "docs/.docs-index.json" DOCS_DEFAULTS entry above — a
  // project that customizes docs.root without also setting
  // docs.docsIndexJson would otherwise get a default silently pointing at
  // the WRONG folder. Derived the same way as the other docs.* defaults
  // (`${docsRoot}/.docs-index.json`).
  const docsRootRaw = (cfg.root || DOCS_DEFAULTS.root).replace(/[/\\]+$/, "");
  const docsIndexJsonDefault = `${docsRootRaw}/.docs-index.json`;

  return {
    root: pick("root"),
    index: pick("index"),
    tasks: pick("tasks", "NEXT_TASK_ID_TASKS_FILE"),
    decisions: pick("decisions", "NEXT_TASK_ID_DECISIONS_FILE"),
    log: pick("log", "NEXT_TASK_ID_LOG_FILE"),
    gaps: pick("gaps"),
    docsIndexJson: resolve(root, cfg.docsIndexJson || docsIndexJsonDefault),
    changelog: pick("changelog"),
    // MJ-1: doc-relative path prefixes (under docs.root) exempt from the
    // drift gate's point-to-code anchor check — see check-docs-drift.mjs's
    // use of this. Not filesystem-resolved (they're prefixes matched
    // against a doc's path relative to docs.root, not paths read directly).
    ephemeralPaths: Array.isArray(cfg.ephemeralPaths) ? cfg.ephemeralPaths : [],
  };
}

/** Default project-root resolution shared by every bundled docs script's CLI entry. */
export function defaultRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
