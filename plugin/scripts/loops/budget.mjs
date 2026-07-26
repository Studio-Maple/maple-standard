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
 * Importable: checkBudget({ usedCount, countLimit, startedAt, minutesLimit, now }).
 * CLI: node budget.mjs check --used N [--limit N] [--started-at ISO|MS]
 *        [--minutes-limit N] [--now MS]
 *      exit 0 = not exceeded, exit 1 = exceeded. Always prints a JSON result.
 */

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

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd !== "check") {
    console.error(
      "Usage: node budget.mjs check --used N [--limit N] [--started-at ISO|MS] [--minutes-limit N] [--now MS]"
    );
    process.exit(2);
  }
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--used") opts.usedCount = Number(argv[++i]);
    else if (a === "--limit") opts.countLimit = Number(argv[++i]);
    else if (a === "--started-at") opts.startedAt = argv[++i];
    else if (a === "--minutes-limit") opts.minutesLimit = Number(argv[++i]);
    else if (a === "--now") opts.now = Number(argv[++i]);
  }
  const result = checkBudget(opts);
  process.stdout.write(JSON.stringify(result));
  process.exit(result.exceeded ? 1 : 0);
}

function isMain() {
  if (!process.argv[1]) return false;
  const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  return import.meta.url === argvUrl;
}

if (isMain()) {
  main();
}
