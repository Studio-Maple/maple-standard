#!/usr/bin/env node
/**
 * loop-budget-guard.mjs — PreToolUse hook (docs/tasks.md #T8 mechanization,
 * MJ-8). Part of the maple-standard plugin (plugin/hooks/hooks.json).
 *
 * Makes the loop pack's per-cycle budget (docs/loop-pack.md principle 2 —
 * "every loop has a hard budget... hit the cap -> stop, revert uncommitted
 * work, log it") a MECHANISM instead of prose the loop has to remember to
 * re-check on its own. Each loop command now calls `budget.mjs start` at
 * cycle start (step 0), writing `.loop-state/current-cycle.json`
 * (turnLimit / minutesLimit / a pre-computed deadlineMs / a toolCalls
 * counter this hook maintains). This hook reads that file on EVERY tool
 * call and blocks (exit 2) once the cycle is over budget on either
 * dimension — independent of whether the agent bothers to call `check`
 * itself.
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
 * staleness handling (MJ-2) — a missing/expired guard shouldn't block
 * forever, only the live window it was created for.
 *
 * PROJECT ROOT: the hook payload's own `cwd` field (falling back to
 * $CLAUDE_PROJECT_DIR, then process.cwd()) — same convention as every
 * other plugin hook (not import.meta.url, which resolves inside the
 * plugin's install directory, not the adopting project/worktree).
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { loopStateFilePath, loopStateDir } from "../scripts/loops/state.mjs";

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

// Best-effort atomic increment of toolCalls — same tmp+rename pattern
// state.mjs's writeLoopState uses. Not perfectly race-proof under true
// concurrency, but PreToolUse hooks within one session run serialized;
// a failed bump just means this one call isn't counted, never a crash.
function bumpToolCalls(root, file, cycle) {
  const next = { ...cycle, toolCalls: (cycle.toolCalls || 0) + 1 };
  try {
    const dir = loopStateDir(root);
    const tmp = `${dir}/.current-cycle.json.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch {
    /* best-effort */
  }
  return next;
}

function main() {
  const payload = readStdinPayload();
  const root = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const file = loopStateFilePath(root, "current-cycle");

  if (!existsSync(file)) process.exit(0); // no active cycle — strict no-op

  const cycle = readCycle(file);
  if (!cycle) process.exit(0); // corrupt/unreadable — fail open, never block on our own bug

  const startedMs = Date.parse(cycle.startedAt);
  if (Number.isFinite(startedMs) && Date.now() - startedMs > STALE_MS) {
    process.exit(0); // abandoned cycle — don't lock out a later session
  }

  const now = Date.now();
  const reasons = [];
  if (Number.isFinite(cycle.deadlineMs) && now >= cycle.deadlineMs) {
    reasons.push(`wall-clock budget exceeded (deadline ${new Date(cycle.deadlineMs).toISOString()})`);
  }

  const bumped = bumpToolCalls(root, file, cycle);
  if (Number.isFinite(cycle.turnLimit) && bumped.toolCalls > cycle.turnLimit) {
    reasons.push(`turn budget exceeded (${bumped.toolCalls}/${cycle.turnLimit} tool calls)`);
  }

  if (reasons.length) {
    console.error(
      `LOOP BUDGET EXCEEDED — ${reasons.join("; ")}. Stop now: revert any uncommitted work ` +
        `(git reset --hard to the pre-attempt SHA), record the outcome in .loop-state/, run this ` +
        `loop's Report step (which clears the cycle file), and end the cycle. Do not start new work.`
    );
    process.exit(2);
  }

  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0); // never block a normal session on this hook's own bug
}
