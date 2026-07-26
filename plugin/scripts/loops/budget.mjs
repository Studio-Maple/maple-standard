#!/usr/bin/env node
/**
 * budget.mjs (loop pack, docs/tasks.md #T8) — budget enforcement, per
 * docs/loop-pack.md principle 2: "every loop has a hard budget... hit the
 * cap -> stop, revert uncommitted work, log it. No loop free-runs." One
 * boundary check, two uses:
 *
 *  - PER-CYCLE budget: each loop command tracks its own iteration count
 *    (the "turns" proxy — the command reports one iteration per meaningful
 *    step it takes) against `loops.budgetPerCycle.turns`, and wall-clock
 *    elapsed since the cycle started against `loops.budgetPerCycle.minutes`.
 *  - SESSION-LEVEL cap: /dev-burner step 2's "global budget check" against
 *    the optional `loops.sessionCap.cycles` / `.hours` (plugin extension —
 *    unset means no session cap; the standing /loop session's own stop
 *    mechanism is the only ceiling, matching the pre-spec stub's note that
 *    /dev-burner "has no global ceiling of its own" unless configured).
 *
 * Both are the SAME check: `usedCount >= countLimit` is exceeded (AT the
 * cap counts as exceeded, not one past it) and/or elapsed minutes past
 * `minutesLimit` is exceeded — either count-based or time-based, whichever
 * limit is supplied; either, both, or neither may be set (unset = no cap
 * on that dimension).
 *
 * MJ-8 (docs/tasks.md #T8 mechanization): before this, the per-cycle budget
 * was enforced ONLY by each loop command's own prose re-checking `check`
 * at specific points — pure trust that the agent running the loop actually
 * does so, and stops if it says exceeded. That contradicts this repo's own
 * "enforce by mechanism, not by trust" rule. `start`/`end` below make it
 * mechanical: `start` writes the cycle's turn-cap + wall-clock deadline to
 * `.loop-state/current-cycle.json`; a PreToolUse hook
 * (plugin/hooks/loop-budget-guard.mjs) reads that file on EVERY tool call
 * and blocks (exit 2) once the cycle is over budget, independent of
 * whether the agent bothers to call `check` itself. `end` removes the
 * file — every loop's own final "Report" step calls it, so the guard goes
 * back to a strict no-op the moment the cycle is done (success, failure,
 * or budget-exceeded) and never gates a later, unrelated session.
 *
 * Importable: checkBudget({ usedCount, countLimit, startedAt, minutesLimit, now }).
 * CLI: node budget.mjs check --used N [--limit N] [--started-at ISO|MS]
 *        [--minutes-limit N] [--now MS]
 *      exit 0 = not exceeded, exit 1 = exceeded. Always prints a JSON result.
 *      node budget.mjs start [--loop <name>] [--limit N] [--minutes-limit N]
 *        [--root <path>] [--now MS]
 *      -> writes .loop-state/current-cycle.json (turnLimit/minutesLimit/
 *         deadlineMs/startedAt/toolCalls:0); exit 0.
 *      node budget.mjs end [--root <path>]
 *      -> removes .loop-state/current-cycle.json if present; exit 0.
 */
import { writeLoopState, loopStateFilePath } from "./state.mjs";
import { existsSync, unlinkSync } from "node:fs";

function toMs(t) {
  if (t === undefined || t === null || t === "") return null;
  const ms = typeof t === "number" ? t : Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {object} opts
 * @param {number} [opts.usedCount] iterations/cycles used so far
 * @param {number} [opts.countLimit] cap on usedCount (turns or cycles)
 * @param {string|number} [opts.startedAt] ISO string or epoch ms the window started
 * @param {number} [opts.minutesLimit] wall-clock cap in minutes from startedAt
 * @param {number} [opts.now] epoch ms "now" override (tests)
 * @returns {{exceeded: boolean, reasons: string[], elapsedMinutes: number|null}}
 */
export function checkBudget({ usedCount, countLimit, startedAt, minutesLimit, now = Date.now() } = {}) {
  const reasons = [];

  if (Number.isFinite(countLimit) && Number.isFinite(usedCount) && usedCount >= countLimit) {
    reasons.push(`count: ${usedCount}/${countLimit}`);
  }

  const startMs = toMs(startedAt);
  let elapsedMinutes = null;
  if (startMs !== null) {
    elapsedMinutes = (now - startMs) / 60000;
    if (Number.isFinite(minutesLimit) && elapsedMinutes >= minutesLimit) {
      reasons.push(`elapsed: ${elapsedMinutes.toFixed(1)}m/${minutesLimit}m`);
    }
  }

  return { exceeded: reasons.length > 0, reasons, elapsedMinutes };
}

// ---- CLI --------------------------------------------------------------------

function defaultRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

const USAGE =
  "Usage: node budget.mjs check --used N [--limit N] [--started-at ISO|MS] [--minutes-limit N] [--now MS]\n" +
  "       node budget.mjs start [--loop <name>] [--limit N] [--minutes-limit N] [--root <path>] [--now MS]\n" +
  "       node budget.mjs end [--root <path>]";

function parseFlags(argv, spec) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const key = spec[argv[i]];
    if (key) opts[key] = argv[++i];
  }
  return opts;
}

function cmdCheck(argv) {
  const raw = parseFlags(argv, {
    "--used": "usedCount",
    "--limit": "countLimit",
    "--started-at": "startedAt",
    "--minutes-limit": "minutesLimit",
    "--now": "now",
  });
  const opts = {
    usedCount: raw.usedCount !== undefined ? Number(raw.usedCount) : undefined,
    countLimit: raw.countLimit !== undefined ? Number(raw.countLimit) : undefined,
    startedAt: raw.startedAt,
    minutesLimit: raw.minutesLimit !== undefined ? Number(raw.minutesLimit) : undefined,
    now: raw.now !== undefined ? Number(raw.now) : undefined,
  };
  const result = checkBudget(opts);
  process.stdout.write(JSON.stringify(result));
  process.exit(result.exceeded ? 1 : 0);
}

// Write .loop-state/current-cycle.json — the mechanical guard's ONLY input
// (MJ-8). turnLimit/minutesLimit are recorded as configured (possibly
// unset -> null, meaning "no cap on that dimension", same convention as
// checkBudget itself); deadlineMs is pre-computed from minutesLimit so the
// guard only ever has to compare against the clock, never redo the math.
function cmdStart(argv) {
  const raw = parseFlags(argv, {
    "--loop": "loop",
    "--limit": "countLimit",
    "--minutes-limit": "minutesLimit",
    "--root": "root",
    "--now": "now",
  });
  const root = raw.root || defaultRoot();
  const now = raw.now !== undefined ? Number(raw.now) : Date.now();
  const turnLimit = raw.countLimit !== undefined && Number.isFinite(Number(raw.countLimit)) ? Number(raw.countLimit) : null;
  const minutesLimit =
    raw.minutesLimit !== undefined && Number.isFinite(Number(raw.minutesLimit)) ? Number(raw.minutesLimit) : null;
  const cycle = {
    loop: raw.loop || null,
    startedAt: new Date(now).toISOString(),
    turnLimit,
    minutesLimit,
    deadlineMs: minutesLimit !== null ? now + minutesLimit * 60000 : null,
    toolCalls: 0,
  };
  const file = writeLoopState(root, "current-cycle", cycle);
  console.log(`OK — wrote ${file}`);
  process.exit(0);
}

function cmdEnd(argv) {
  const raw = parseFlags(argv, { "--root": "root" });
  const root = raw.root || defaultRoot();
  const file = loopStateFilePath(root, "current-cycle");
  if (existsSync(file)) unlinkSync(file);
  console.log(`OK — cleared ${file}`);
  process.exit(0);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (cmd === "check") return cmdCheck(rest);
  if (cmd === "start") return cmdStart(rest);
  if (cmd === "end") return cmdEnd(rest);
  console.error(USAGE);
  process.exit(2);
}

function isMain() {
  if (!process.argv[1]) return false;
  const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  return import.meta.url === argvUrl;
}

if (isMain()) {
  main();
}
