#!/usr/bin/env node
/**
 * pick-loop.mjs (loop pack, docs/tasks.md #T8) — deterministic loop
 * selection for /dev-burner's cycle step 3 ("pick a loop for this cycle",
 * docs/loop-pack.md): weighted round-robin over `maple.config.json`
 * `loops.enabled`, weighted by `loops.weights` (plugin extension, default 1
 * per loop), with a cooldown for a loop that reported "quiet" recently
 * (`loops.cooldownCycles`, plugin extension, default 3 cycles) so it
 * doesn't hog cycles doing nothing, and a priority override for
 * sweep-errors when the caller signals new high-severity tracker issues.
 *
 * Deterministic given a fixed ledger — no randomness, no wall-clock input.
 * Weighted round-robin picks the eligible loop with the lowest
 * (times-picked / weight) ratio so far, "times picked" counted from every
 * ledger entry for that loop regardless of outcome (a loop that ran and
 * found nothing to do still used its turn in the rotation). Ties break by
 * `loops.enabled` array order (itself a deterministic, config-owned
 * sequence) — candidates are iterated in that order and the first minimum
 * wins, so no separate tie-break pass is needed.
 *
 * Cooldown: a loop whose MOST RECENT ledger entry has outcome "quiet" AND
 * that entry is within the last `cooldownCycles` ledger entries (counted
 * across all loops, not just this one) is excluded from the candidate pool
 * this cycle — UNLESS excluding it (and every other cooling-down loop)
 * would leave zero candidates, in which case cooldown is ignored for this
 * cycle only (a cycle must always pick something) and `reason` says so.
 *
 * Priority: if `sweepErrorsPriority` is true and "sweep-errors" is in
 * `loops.enabled`, it is picked regardless of rotation/cooldown — a fresh
 * high-severity issue invalidates any "quiet" cooldown sweep-errors was in.
 *
 * Importable: pickLoop({ config, ledgerEntries, sweepErrorsPriority }).
 * CLI: node pick-loop.mjs [--root <path>] [--sweep-errors-priority]
 *      -> prints {"loop": "...", "reason": "...", "candidates": [...]}
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readLedgerEntries } from "./ledger.mjs";

export const LOOP_NAMES = ["sweep-errors", "burn-backlog", "sweep-quality", "detect-drift"];
const DEFAULT_ENABLED = [...LOOP_NAMES];
const DEFAULT_COOLDOWN_CYCLES = 3;

export function loadMapleConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, "maple.config.json"), "utf8"));
  } catch {
    return {};
  }
}

function enabledLoops(config) {
  // Array.isArray, not "&& length > 0": an explicit `loops.enabled: []` means
  // "run nothing" and must be honored (pickLoop throws below), not silently
  // treated as unset and fall back to every loop.
  const enabled = config?.loops?.enabled;
  return Array.isArray(enabled) ? enabled : DEFAULT_ENABLED;
}

function weightOf(config, loop) {
  const w = config?.loops?.weights?.[loop];
  return Number.isInteger(w) && w >= 1 ? w : 1;
}

function cooldownCyclesOf(config) {
  const c = config?.loops?.cooldownCycles;
  return Number.isInteger(c) && c >= 0 ? c : DEFAULT_COOLDOWN_CYCLES;
}

/** How many times has `loop` been picked, per the ledger (every entry counts,
 * regardless of outcome — a cycle spent finding nothing still used a turn). */
function pickCount(ledgerEntries, loop) {
  return ledgerEntries.filter((e) => e.loop === loop).length;
}

/** Is `loop` cooling down? Its most recent ledger entry is "quiet" AND lies
 * within the last `cooldown` ledger entries overall. A loop that has never
 * run is never cooling down. */
function isCoolingDown(ledgerEntries, loop, cooldown) {
  if (cooldown <= 0) return false;
  const lastIdx = ledgerEntries.length - 1;
  for (let i = lastIdx; i >= 0; i--) {
    if (ledgerEntries[i].loop === loop) {
      const cyclesAgo = lastIdx - i;
      return ledgerEntries[i].outcome === "quiet" && cyclesAgo < cooldown;
    }
  }
  return false;
}

/**
 * @param {object} opts
 * @param {object} [opts.config] parsed maple.config.json (or {})
 * @param {Array} [opts.ledgerEntries] prior cycle history, oldest first
 * @param {boolean} [opts.sweepErrorsPriority]
 * @returns {{loop: string, reason: string, candidates: string[]}}
 */
export function pickLoop({ config = {}, ledgerEntries = [], sweepErrorsPriority = false } = {}) {
  const enabled = enabledLoops(config);
  if (enabled.length === 0) {
    throw new Error("loops.enabled is empty — nothing to pick");
  }

  if (sweepErrorsPriority && enabled.includes("sweep-errors")) {
    return {
      loop: "sweep-errors",
      reason: "priority override: new high-severity tracker issues since last cycle",
      candidates: enabled,
    };
  }

  const cooldown = cooldownCyclesOf(config);
  let candidates = enabled.filter((l) => !isCoolingDown(ledgerEntries, l, cooldown));
  let reason;
  if (candidates.length === 0) {
    candidates = enabled;
    reason = "all eligible loops cooling down — ignoring cooldown this cycle so something still runs";
  } else {
    reason = "weighted round-robin (lowest picks/weight ratio)";
  }

  let best = null;
  let bestRatio = Infinity;
  for (const loop of candidates) {
    const ratio = pickCount(ledgerEntries, loop) / weightOf(config, loop);
    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = loop;
    }
  }
  return { loop: best, reason, candidates };
}

// ---- CLI --------------------------------------------------------------------

function defaultRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function main() {
  const argv = process.argv.slice(2);
  let root = defaultRoot();
  let sweepErrorsPriority = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = argv[++i];
    else if (argv[i] === "--sweep-errors-priority") sweepErrorsPriority = true;
  }
  const config = existsSync(join(root, "maple.config.json")) ? loadMapleConfig(root) : {};
  const { entries } = readLedgerEntries(root);
  // pickLoop() throws for importers on an empty loops.enabled (documented,
  // deliberate — "run nothing" must be honored, not silently substituted).
  // The CLI entry point used to let that propagate as a raw uncaught-
  // exception stack trace; /dev-burner (and any other caller) just needs a
  // clean, non-zero, parseable-by-a-human failure instead.
  let result;
  try {
    result = pickLoop({ config, ledgerEntries: entries, sweepErrorsPriority });
  } catch (e) {
    console.error(`[pick-loop] ${e.message} — nothing to run this cycle (loops.enabled is empty in maple.config.json)`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

function isMain() {
  if (!process.argv[1]) return false;
  const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  return import.meta.url === argvUrl;
}

if (isMain()) {
  main();
}
