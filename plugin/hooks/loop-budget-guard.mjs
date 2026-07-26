#!/usr/bin/env node
/**
 * loop-budget-guard.mjs — PreToolUse hook (docs/tasks.md #T8 mechanization,
 * MJ-8). Part of the maple-standard plugin (plugin/hooks/hooks.json).
 *
 * Makes the loop pack's per-cycle budget (docs/loop-pack.md principle 2 —
 * "every loop has a hard budget... hit the cap -> stop, revert uncommitted
 * work, log it") a MECHANISM instead of prose the loop has to remember to
 * re-check on its own. Each loop command calls `budget.mjs start` at cycle
 * start (step 0), writing `.loop-state/current-cycle.json`. This hook reads
 * that file on EVERY tool call and, once the cycle is over budget, delivers
 * ONE mechanical stop signal — independent of whether the agent bothers to
 * call `check` itself.
 *
 * Re-review fixes (this pass):
 *
 *   B1 — ONE-SHOT stop, not a standing block. The previous version exited 2
 *   on every tool call once over budget — including the Bash/Write/Edit the
 *   stop message itself told the agent to use to revert, log the outcome,
 *   and clear the cycle file, an unrecoverable deadlock (the only escape
 *   was the 6h staleness window; the standing worktree was bricked
 *   meanwhile). Now: the FIRST violation writes `blocked: true` into the
 *   cycle file and exits 2 with the stop message; EVERY call after that,
 *   for the same cycle, allows (exit 0) — the mechanical stop already
 *   happened exactly once, and the agent needs those tools to wind the
 *   cycle down. `budget.mjs start` never writes `blocked`, so a fresh cycle
 *   is always unblocked.
 *
 *   B2 — a SEPARATE budget for raw tool calls. This hook increments once
 *   per TOOL CALL; the loop commands' own `budget.mjs check --used $ITER`
 *   increments once per meaningful STEP (docs/loop-pack.md's "turns").
 *   Comparing the tool-call counter against the turn limit
 *   (`loops.budgetPerCycle.turns`, default 40) blocked at raw tool call #41
 *   — roughly iteration 3-4 of an intended 40. This hook now enforces
 *   `cycle.toolCallLimit` (from `loops.budgetPerCycle.toolCalls`, default
 *   400 — deliberately generous, a RUNAWAY BACKSTOP, not the primary
 *   budget) and never reads `cycle.turnLimit` at all. The primary per-cycle
 *   budget (turns + minutes) stays enforced by each command's own `check`
 *   calls in its own procedure.
 *
 * STRICT NO-OP (exit 0, no output) whenever `.loop-state/current-cycle.json`
 * doesn't exist — i.e. every normal, non-loop session, and every loop
 * session once its cycle has ended. Each loop's own final "Report" step
 * calls `budget.mjs end` to remove the file, so the guard reverts to
 * no-op the moment the cycle finishes (success, failure, or
 * budget-exceeded) — it never gates a session the cycle it was created
 * for has already moved past.
 *
 * Self-healing against an ABANDONED cycle file (a crash before the loop's
 * own Report/`budget.mjs end` step ran, or a standing worktree nobody ever
 * revisited): a cycle file older than STALE_MS is treated as abandoned,
 * not enforced, rather than permanently locking out whatever session next
 * touches that worktree. Same reasoning as maple-lib.sh's land-lock
 * staleness handling (MJ-2). M2 (this pass): a missing/unparseable
 * `startedAt` used to SKIP this check entirely (Date.parse -> NaN ->
 * `Number.isFinite` false), which meant a corrupted `startedAt` was
 * enforced FOREVER — the opposite of fail-open. Now: `startedAt` accepts
 * an ISO string OR a numeric epoch (shared `toMs` helper, same as
 * budget.mjs); if it's absent/unparseable, fall back to the cycle FILE's
 * own mtime as the age signal; if even that's unavailable, fail open
 * immediately (allow) rather than guess.
 *
 * PROJECT ROOT (M4, this pass): resolved via the same canonical
 * `resolveLoopRoot` helper state.mjs and budget.mjs use — git worktree
 * toplevel from the hook payload's own `cwd` (falling back to
 * $CLAUDE_PROJECT_DIR, then process.cwd()), NOT a bare
 * `payload.cwd || CLAUDE_PROJECT_DIR || cwd` guess. The three used to
 * disagree whenever CLAUDE_PROJECT_DIR pointed at the main checkout while
 * the session had cd'd into a worktree: budget.mjs wrote the cycle file
 * into the main checkout, this hook read the worktree, found nothing, and
 * silently never fired.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, statSync } from "node:fs";
import { loopStateFilePath, loopStateDir } from "../scripts/loops/state.mjs";
import { toMs } from "../scripts/loops/budget.mjs";
import { resolveLoopRoot } from "../scripts/loops/resolve-root.mjs";

const STALE_MS = 6 * 60 * 60 * 1000; // 6h — an abandoned cycle file stops being enforced

function readStdinPayload() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function readCycle(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Atomic tmp+rename write (rename is atomic on the same filesystem on every
// platform this runs on, including Windows NTFS) — shared by the toolCalls
// bump and the one-shot `blocked` write below.
//
// m2: this used to run on EVERY tool call even when no limit was configured
// at all (nothing to gate, pure overhead), swallowed write/rename failures
// in an empty catch (20 concurrent invocations lost 7 increments and leaked
// a .tmp file with no trace of why), and never cleaned up its own tmp file
// on failure. Now: callers only invoke this when something actually
// changed (see main()); a failure is reported to stderr (never thrown —a
// failed bookkeeping write must not itself become the reason a tool call
// gets blocked or a normal session breaks) and any tmp file left behind by
// a failed write is removed rather than leaked.
function writeCycleFile(root, file, next) {
  const dir = loopStateDir(root);
  const tmp = `${dir}/.current-cycle.json.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort cleanup of our own tmp file — never let this mask the real error below */
    }
    process.stderr.write(`loop-budget-guard: failed to persist cycle state (${e.message}) — continuing unblocked\n`);
  }
}

function main() {
  const payload = readStdinPayload();
  const root = resolveLoopRoot(payload.cwd); // M4
  const file = loopStateFilePath(root, "current-cycle");

  if (!existsSync(file)) process.exit(0); // no active cycle — strict no-op

  const cycle = readCycle(file);
  if (!cycle) process.exit(0); // corrupt/unreadable — fail open, never block on our own bug

  // M2: absent/unparseable startedAt must FAIL OPEN, never enforce forever.
  // toMs accepts an ISO string OR a numeric epoch. Fall back to the cycle
  // FILE's own mtime (same reasoning as maple-lib.sh's land-lock staleness
  // handling) before giving up and allowing outright.
  let startedMs = toMs(cycle.startedAt);
  if (startedMs === null) {
    try {
      startedMs = statSync(file).mtimeMs;
    } catch {
      startedMs = null;
    }
  }
  if (startedMs === null || Date.now() - startedMs > STALE_MS) {
    process.exit(0); // unknown age, or abandoned — don't lock out a later session
  }

  // B1: ONE-SHOT stop. This cycle already delivered its single mechanical
  // block — every call after that allows, so the agent can actually use
  // Bash/Write/Edit/TodoWrite to revert, log the ledger entry, and clear
  // the cycle (re-blocking those exact tools was the unrecoverable
  // deadlock this fixes).
  if (cycle.blocked === true) {
    process.exit(0);
  }

  const now = Date.now();
  const reasons = [];
  if (Number.isFinite(cycle.deadlineMs) && now >= cycle.deadlineMs) {
    reasons.push(`wall-clock budget exceeded (deadline ${new Date(cycle.deadlineMs).toISOString()})`);
  }

  // B2: a SEPARATE, generous backstop over raw tool calls — never
  // cycle.turnLimit, which counts loop iterations, a much smaller number.
  // m2: only bump/persist when a toolCallLimit is actually configured —
  // with none set there's nothing this counter could ever gate, so skip
  // the write entirely (the common case: every hook invocation on every
  // ordinary tool call for the life of the cycle, otherwise).
  let nextCycle = cycle;
  if (Number.isFinite(cycle.toolCallLimit)) {
    // m3: Number() coercion — `(cycle.toolCalls || 0) + 1` on a string
    // value (possible after a hand-edited or older-shaped cycle file)
    // silently string-concatenates ("3" -> "31" -> "311") instead of
    // adding, blocking at a fraction of the configured limit.
    const nextCount = (Number(cycle.toolCalls) || 0) + 1;
    nextCycle = { ...cycle, toolCalls: nextCount };
    if (nextCount > cycle.toolCallLimit) {
      reasons.push(`tool-call budget exceeded (${nextCount}/${cycle.toolCallLimit} tool calls — runaway backstop, not the per-cycle turn budget)`);
    }
  }

  if (reasons.length) {
    writeCycleFile(root, file, { ...nextCycle, blocked: true });
    console.error(
      `LOOP BUDGET EXCEEDED — ${reasons.join("; ")}. This is the SINGLE stop signal for this cycle (one-shot — ` +
        `every tool call from here on is allowed so you can act on it, this one included next time). Wind the ` +
        `cycle down now: revert any uncommitted work (git reset --hard to the pre-attempt SHA), record the ` +
        `outcome in .loop-state/, run this loop's Report step (which clears the cycle via \`budget.mjs end\`), ` +
        `and end the cycle. Do not start new work.`
    );
    process.exit(2);
  }

  // Only persist when something actually changed (m2) — a deadline-only
  // cycle with no toolCallLimit configured never writes at all.
  if (nextCycle !== cycle) {
    writeCycleFile(root, file, nextCycle);
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // never block a normal session on this hook's own bug
}
