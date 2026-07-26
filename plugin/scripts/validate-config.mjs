#!/usr/bin/env node
/**
 * validate-config.mjs (plugin-bundled, docs/tasks.md #T11) — hand-rolled
 * validator for `maple.config.json` against the canonical shape documented
 * in `plugin/schema/maple.config.schema.json` (itself a mirror of
 * docs/standard-architecture.md's `maple.config.json` schema, plus the
 * plugin's own operational extensions — see plugin/README.md "Schema
 * reconciliation"). No JSON-Schema library dependency (none of this repo's
 * scripts take on new deps) — this hand-checks required fields, types, the
 * `errorTracker.provider` enum, and path-shaped strings, mirroring the
 * schema file closely enough that the two stay in sync by inspection.
 *
 * Every command/hook that reads `maple.config.json` and hits something it
 * can't make sense of should point the user at this script rather than
 * guessing — see plugin/README.md and each command's "Config" section.
 *
 * CLI:
 *   node validate-config.mjs [path/to/maple.config.json]
 *     default path: <project root>/maple.config.json
 *     project root: $CLAUDE_PROJECT_DIR or cwd
 *   exit 0 + "OK" on a clean config (or a config file that doesn't exist —
 *     nothing to validate, every command's own defaults apply)
 *   exit 1 + one message per problem, to stderr, on a malformed config
 *
 * Importable: `import { validateConfig } from "./validate-config.mjs"` —
 * takes a parsed config object, returns a string[] of problems (empty =
 * valid). Used by /adopt-standard to validate a draft before writing it.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ERROR_TRACKER_PROVIDERS = ["sentry", "maplelens"];
const LOOP_NAMES = ["sweep-errors", "burn-backlog", "sweep-quality", "detect-drift"];

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}
/** "path-shaped": a non-empty string, no NUL/control bytes. Doesn't require the path to exist. */
function isPathShaped(v) {
  if (!isNonEmptyString(v)) return false;
  for (let i = 0; i < v.length; i++) {
    if (v.charCodeAt(i) < 0x20) return false;
  }
  return true;
}
function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function isPathArray(v) {
  return Array.isArray(v) && v.every((x) => isPathShaped(x));
}
function isInt(v) {
  return typeof v === "number" && Number.isInteger(v);
}
function isIntMin(v, min) {
  return isInt(v) && v >= min;
}
function isBool(v) {
  return typeof v === "boolean";
}
function isNullableString(v) {
  return v === null || typeof v === "string";
}

/** Fail loud on any key not in `allowed` — "one key set, no aliases" (#T11). */
function checkNoExtraKeys(obj, allowed, blockPath, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      errors.push(`${blockPath}.${key}: unknown key (not part of the canonical schema — see plugin/schema/maple.config.schema.json)`);
    }
  }
}

/**
 * @param {object} config parsed maple.config.json
 * @returns {string[]} problems (empty array = valid)
 */
export function validateConfig(config) {
  const errors = [];

  if (!isPlainObject(config)) {
    return ["root: maple.config.json must contain a JSON object"];
  }
  checkNoExtraKeys(
    config,
    ["$schema", "project", "repo", "worktrees", "docs", "ci", "lint", "sizeCaps", "errorTracker", "loops", "hooks"],
    "root",
    errors
  );

  if (config.$schema !== undefined && typeof config.$schema !== "string") {
    errors.push("$schema: must be a string");
  }

  // ---- project (required) ----------------------------------------------
  if (!isPlainObject(config.project)) {
    errors.push("project: required object (project.name, project.slug) is missing");
  } else {
    checkNoExtraKeys(config.project, ["name", "slug"], "project", errors);
    if (!isNonEmptyString(config.project.name)) errors.push("project.name: required non-empty string");
    if (!isNonEmptyString(config.project.slug)) {
      errors.push("project.slug: required non-empty string");
    } else if (!/^[a-z0-9-]+$/.test(config.project.slug)) {
      errors.push(`project.slug: "${config.project.slug}" must match ^[a-z0-9-]+$ (lowercase letters, digits, hyphens)`);
    }
  }

  // ---- repo ---------------------------------------------------------------
  if (config.repo !== undefined) {
    if (!isPlainObject(config.repo)) {
      errors.push("repo: must be an object");
    } else {
      checkNoExtraKeys(config.repo, ["prodCheckout", "devCheckout", "prodBranch", "devBranch", "standingLoopBranch", "remote"], "repo", errors);
      for (const key of ["prodCheckout", "devCheckout"]) {
        if (config.repo[key] !== undefined && !isPathShaped(config.repo[key])) errors.push(`repo.${key}: must be a path-shaped string`);
      }
      for (const key of ["prodBranch", "devBranch", "standingLoopBranch", "remote"]) {
        if (config.repo[key] !== undefined && !isNonEmptyString(config.repo[key])) errors.push(`repo.${key}: must be a non-empty string`);
      }
    }
  }

  // ---- worktrees ------------------------------------------------------------
  if (config.worktrees !== undefined) {
    if (!isPlainObject(config.worktrees)) {
      errors.push("worktrees: must be an object");
    } else {
      checkNoExtraKeys(
        config.worktrees,
        ["root", "namePattern", "nodeModulesDirs", "envFiles", "freshDepsCommand", "preview", "lock", "reap"],
        "worktrees",
        errors
      );
      if (config.worktrees.root !== undefined && !isPathShaped(config.worktrees.root)) errors.push("worktrees.root: must be a path-shaped string");
      if (config.worktrees.namePattern !== undefined) {
        if (!isNonEmptyString(config.worktrees.namePattern)) errors.push("worktrees.namePattern: must be a non-empty string");
        else if (!config.worktrees.namePattern.includes("<slug>")) errors.push('worktrees.namePattern: must contain the literal "<slug>" placeholder');
      }
      if (config.worktrees.nodeModulesDirs !== undefined && !isPathArray(config.worktrees.nodeModulesDirs))
        errors.push("worktrees.nodeModulesDirs: must be an array of path-shaped strings");
      if (config.worktrees.envFiles !== undefined && !isPathArray(config.worktrees.envFiles))
        errors.push("worktrees.envFiles: must be an array of path-shaped strings");
      if (config.worktrees.freshDepsCommand !== undefined && !isNonEmptyString(config.worktrees.freshDepsCommand))
        errors.push("worktrees.freshDepsCommand: must be a non-empty string");

      if (config.worktrees.preview !== undefined) {
        const p = config.worktrees.preview;
        if (!isPlainObject(p)) errors.push("worktrees.preview: must be an object");
        else {
          checkNoExtraKeys(p, ["port", "workdir", "command", "logFile"], "worktrees.preview", errors);
          if (p.port !== undefined && !isIntMin(p.port, 1)) errors.push("worktrees.preview.port: must be a positive integer");
          if (p.workdir !== undefined && !isPathShaped(p.workdir)) errors.push("worktrees.preview.workdir: must be a path-shaped string");
          if (p.command !== undefined && !isNonEmptyString(p.command)) errors.push("worktrees.preview.command: must be a non-empty string");
          if (p.logFile !== undefined && !isPathShaped(p.logFile)) errors.push("worktrees.preview.logFile: must be a path-shaped string");
        }
      }
      if (config.worktrees.lock !== undefined) {
        const l = config.worktrees.lock;
        if (!isPlainObject(l)) errors.push("worktrees.lock: must be an object");
        else {
          checkNoExtraKeys(l, ["ttlSeconds", "waitSeconds", "pollSeconds"], "worktrees.lock", errors);
          for (const key of ["ttlSeconds", "waitSeconds", "pollSeconds"]) {
            if (l[key] !== undefined && !isIntMin(l[key], 1)) errors.push(`worktrees.lock.${key}: must be a positive integer`);
          }
        }
      }
      if (config.worktrees.reap !== undefined) {
        const r = config.worktrees.reap;
        if (!isPlainObject(r)) errors.push("worktrees.reap: must be an object");
        else {
          checkNoExtraKeys(r, ["staleHours"], "worktrees.reap", errors);
          if (r.staleHours !== undefined && !isIntMin(r.staleHours, 1)) errors.push("worktrees.reap.staleHours: must be a positive integer");
        }
      }
    }
  }

  // ---- docs -----------------------------------------------------------------
  if (config.docs !== undefined) {
    if (!isPlainObject(config.docs)) {
      errors.push("docs: must be an object");
    } else {
      const docsKeys = ["root", "index", "decisions", "tasks", "gaps", "log", "docsIndexJson", "changelog"];
      checkNoExtraKeys(config.docs, docsKeys, "docs", errors);
      for (const key of docsKeys) {
        if (config.docs[key] !== undefined && !isPathShaped(config.docs[key])) errors.push(`docs.${key}: must be a path-shaped string`);
      }
    }
  }

  // ---- ci ---------------------------------------------------------------------
  if (config.ci !== undefined) {
    if (!isPlainObject(config.ci)) {
      errors.push("ci: must be an object");
    } else {
      checkNoExtraKeys(config.ci, ["tiers", "prePushTier"], "ci", errors);
      if (config.ci.tiers !== undefined) {
        if (!isPlainObject(config.ci.tiers)) errors.push("ci.tiers: must be an object");
        else {
          for (const [name, cmd] of Object.entries(config.ci.tiers)) {
            if (!isNonEmptyString(cmd)) errors.push(`ci.tiers.${name}: must be a non-empty command string`);
          }
        }
      }
      if (config.ci.prePushTier !== undefined && !isNonEmptyString(config.ci.prePushTier)) errors.push("ci.prePushTier: must be a non-empty string");
    }
  }

  // ---- lint ---------------------------------------------------------------------
  if (config.lint !== undefined) {
    if (!isPlainObject(config.lint)) {
      errors.push("lint: must be an object");
    } else {
      checkNoExtraKeys(config.lint, ["roots", "maxWarnings"], "lint", errors);
      if (config.lint.roots !== undefined && !isPathArray(config.lint.roots)) errors.push("lint.roots: must be an array of path-shaped strings");
      if (config.lint.maxWarnings !== undefined && !isIntMin(config.lint.maxWarnings, 0)) errors.push("lint.maxWarnings: must be a non-negative integer");
    }
  }

  // ---- sizeCaps -------------------------------------------------------------------
  if (config.sizeCaps !== undefined) {
    if (!isPlainObject(config.sizeCaps)) {
      errors.push("sizeCaps: must be an object");
    } else {
      const capKeys = ["hook", "component", "service", "route"];
      checkNoExtraKeys(config.sizeCaps, capKeys, "sizeCaps", errors);
      for (const key of capKeys) {
        if (config.sizeCaps[key] !== undefined && !isIntMin(config.sizeCaps[key], 1)) errors.push(`sizeCaps.${key}: must be a positive integer`);
      }
    }
  }

  // ---- errorTracker -----------------------------------------------------------------
  if (config.errorTracker !== undefined) {
    if (!isPlainObject(config.errorTracker)) {
      errors.push("errorTracker: must be an object");
    } else {
      checkNoExtraKeys(
        config.errorTracker,
        ["provider", "endpoint", "readTokenRef", "writeTokenRef", "sentryProject", "livePreviewUrl", "query", "verification"],
        "errorTracker",
        errors
      );
      if (config.errorTracker.provider !== undefined && !ERROR_TRACKER_PROVIDERS.includes(config.errorTracker.provider)) {
        errors.push(`errorTracker.provider: must be one of ${JSON.stringify(ERROR_TRACKER_PROVIDERS)}, got ${JSON.stringify(config.errorTracker.provider)}`);
      }
      for (const key of ["endpoint", "readTokenRef", "writeTokenRef", "sentryProject", "livePreviewUrl"]) {
        if (config.errorTracker[key] !== undefined && !isNullableString(config.errorTracker[key])) errors.push(`errorTracker.${key}: must be a string or null`);
      }
      if (config.errorTracker.query !== undefined && typeof config.errorTracker.query !== "string") {
        errors.push("errorTracker.query: must be a string");
      }
      if (config.errorTracker.verification !== undefined) {
        const v = config.errorTracker.verification;
        if (!isPlainObject(v)) errors.push("errorTracker.verification: must be an object");
        else {
          checkNoExtraKeys(v, ["t1", "t2", "t3", "t4", "t5"], "errorTracker.verification", errors);
          if (v.t1 !== undefined && !isStringArray(v.t1)) errors.push("errorTracker.verification.t1: must be an array of strings");
          if (v.t2 !== undefined) {
            if (!isPlainObject(v.t2)) errors.push("errorTracker.verification.t2: must be an object");
            else {
              checkNoExtraKeys(v.t2, ["pushCommand", "ciWatchCommand"], "errorTracker.verification.t2", errors);
              if (v.t2.pushCommand !== undefined && typeof v.t2.pushCommand !== "string") errors.push("errorTracker.verification.t2.pushCommand: must be a string");
              if (v.t2.ciWatchCommand !== undefined && typeof v.t2.ciWatchCommand !== "string") errors.push("errorTracker.verification.t2.ciWatchCommand: must be a string");
            }
          }
          if (v.t3 !== undefined) {
            if (!isPlainObject(v.t3)) errors.push("errorTracker.verification.t3: must be an object");
            else {
              checkNoExtraKeys(v.t3, ["deployUrlTemplate", "waitSeconds"], "errorTracker.verification.t3", errors);
              if (v.t3.deployUrlTemplate !== undefined && typeof v.t3.deployUrlTemplate !== "string")
                errors.push("errorTracker.verification.t3.deployUrlTemplate: must be a string");
              if (v.t3.waitSeconds !== undefined && !isIntMin(v.t3.waitSeconds, 0)) errors.push("errorTracker.verification.t3.waitSeconds: must be a non-negative integer");
            }
          }
          if (v.t4 !== undefined) {
            if (!isPlainObject(v.t4)) errors.push("errorTracker.verification.t4: must be an object");
            else {
              checkNoExtraKeys(v.t4, ["enabled"], "errorTracker.verification.t4", errors);
              if (v.t4.enabled !== undefined && !isBool(v.t4.enabled)) errors.push("errorTracker.verification.t4.enabled: must be a boolean");
            }
          }
          if (v.t5 !== undefined) {
            if (!isPlainObject(v.t5)) errors.push("errorTracker.verification.t5: must be an object");
            else {
              checkNoExtraKeys(v.t5, ["waitMinutes"], "errorTracker.verification.t5", errors);
              if (v.t5.waitMinutes !== undefined && !isIntMin(v.t5.waitMinutes, 0)) errors.push("errorTracker.verification.t5.waitMinutes: must be a non-negative integer");
            }
          }
        }
      }
    }
  }

  // ---- loops ------------------------------------------------------------------------
  if (config.loops !== undefined) {
    if (!isPlainObject(config.loops)) {
      errors.push("loops: must be an object");
    } else {
      checkNoExtraKeys(config.loops, ["enabled", "budgetPerCycle"], "loops", errors);
      if (config.loops.enabled !== undefined) {
        if (!isStringArray(config.loops.enabled)) errors.push("loops.enabled: must be an array of strings");
        else {
          for (const name of config.loops.enabled) {
            if (!LOOP_NAMES.includes(name)) errors.push(`loops.enabled: "${name}" is not one of ${JSON.stringify(LOOP_NAMES)}`);
          }
        }
      }
      if (config.loops.budgetPerCycle !== undefined) {
        const b = config.loops.budgetPerCycle;
        if (!isPlainObject(b)) errors.push("loops.budgetPerCycle: must be an object");
        else {
          checkNoExtraKeys(b, ["turns", "minutes"], "loops.budgetPerCycle", errors);
          if (b.turns !== undefined && !isIntMin(b.turns, 1)) errors.push("loops.budgetPerCycle.turns: must be a positive integer");
          if (b.minutes !== undefined && !isIntMin(b.minutes, 1)) errors.push("loops.budgetPerCycle.minutes: must be a positive integer");
        }
      }
    }
  }

  // ---- hooks ------------------------------------------------------------------------
  if (config.hooks !== undefined) {
    if (!isPlainObject(config.hooks)) {
      errors.push("hooks: must be an object");
    } else {
      checkNoExtraKeys(config.hooks, ["bashGuard"], "hooks", errors);
      if (config.hooks.bashGuard !== undefined) {
        const bg = config.hooks.bashGuard;
        if (!isPlainObject(bg)) errors.push("hooks.bashGuard: must be an object");
        else {
          checkNoExtraKeys(bg, ["cwdGuardEnabled", "pushGuardEnabled", "pushGuardMinTimeoutMs"], "hooks.bashGuard", errors);
          if (bg.cwdGuardEnabled !== undefined && !isBool(bg.cwdGuardEnabled)) errors.push("hooks.bashGuard.cwdGuardEnabled: must be a boolean");
          if (bg.pushGuardEnabled !== undefined && !isBool(bg.pushGuardEnabled)) errors.push("hooks.bashGuard.pushGuardEnabled: must be a boolean");
          if (bg.pushGuardMinTimeoutMs !== undefined && !isIntMin(bg.pushGuardMinTimeoutMs, 0))
            errors.push("hooks.bashGuard.pushGuardMinTimeoutMs: must be a non-negative integer");
        }
      }
    }
  }

  return errors;
}

// ---- CLI --------------------------------------------------------------------------

function defaultRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function main() {
  const argPath = process.argv[2];
  const configPath = argPath ? resolve(argPath) : resolve(defaultRoot(), "maple.config.json");

  if (!existsSync(configPath)) {
    console.log(`OK — no maple.config.json at ${configPath} (every command's own defaults apply)`);
    process.exit(0);
  }

  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (e) {
    console.error(`FAILED to read ${configPath}: ${e.message}`);
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`INVALID JSON in ${configPath}: ${e.message}`);
    process.exit(1);
  }

  const errors = validateConfig(parsed);
  if (errors.length === 0) {
    console.log(`OK — ${configPath} is valid.`);
    process.exit(0);
  }

  console.error(`${configPath} — ${errors.length} problem(s):`);
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

function isMain() {
  if (!process.argv[1]) return false;
  const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  return import.meta.url === argvUrl;
}

if (isMain()) {
  main();
}
