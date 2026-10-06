/**
 * loop-budget-guard.mjs — guard module of the D065 dispatcher (plugin/hooks/guard.mjs),
 * docs/tasks.md #T8 mechanization, MJ-8.
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
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const STALE_MS = 6 * 60 * 60 * 1000; // 6h — an abandoned cycle file stops being enforced

/**
 * Cheap sentinel (D065): is there a `.loop-state/current-cycle.json` in cwd or any ancestor? Pure fs, no git
 * spawn, so the overwhelmingly common no-loop session pays nothing. The exact worktree root is resolved
 * (one git spawn) only when a candidate file exists.
 */
function sentinelExists(start) {
  let dir = resolve(start);
  for (let n = 0; n < 40; n++) {
    if (existsSync(join(dir, ".loop-state", "current-cycle.json"))) return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return false;
}

function readCycle(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Atomic tmp+rename write (rename is atomic on the same filesystem on every platform this runs on,
// including Windows NTFS) — shared by the toolCalls bump and the one-shot `blocked` write below.
// Only called when something actually changed (m2); a failure is reported (never thrown — a failed
// bookkeeping write must not itself become the reason a tool call gets blocked) and a tmp file left
// by a failed write is removed rather than leaked.
function writeCycleFile(dir, file, next) {
  const tmp = `${dir}/.current-cycle.json.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort cleanup of our own tmp file */
    }
    return `loop-budget-guard: failed to persist cycle state (${e.message}) — continuing unblocked`;
  }
  return null;
}

export async function check(ctx) {
  if (!sentinelExists(ctx.cwd)) return undefined; // no active cycle — strict no-op, nothing imported, nothing spawned

  const [{ loopStateFilePath, loopStateDir }, { toMs }, { resolveLoopRoot }] = await Promise.all([
    import("../../scripts/loops/state.mjs"),
    import("../../scripts/loops/budget.mjs"),
    import("../../scripts/loops/resolve-root.mjs"),
  ]);
  const root = resolveLoopRoot(ctx.cwd); // M4
  const file = loopStateFilePath(root, "current-cycle");
  if (!existsSync(file)) return undefined;

  const cycle = readCycle(file);
  if (!cycle) return undefined; // corrupt/unreadable — fail open, never block on our own bug

  // M2: absent/unparseable startedAt must FAIL OPEN, never enforce forever. toMs accepts an ISO string OR a
  // numeric epoch. Fall back to the cycle FILE's own mtime before giving up and allowing outright.
  let startedMs = toMs(cycle.startedAt);
  if (startedMs === null) {
    try {
      startedMs = statSync(file).mtimeMs;
    } catch {
      startedMs = null;
    }
  }
  if (startedMs === null || Date.now() - startedMs > STALE_MS) return undefined; // unknown age, or abandoned

  // B1: ONE-SHOT stop. This cycle already delivered its single mechanical block — every call after that
  // allows, so the agent can actually revert, log the ledger entry and clear the cycle.
  if (cycle.blocked === true) return undefined;

  const now = Date.now();
  const reasons = [];
  if (Number.isFinite(cycle.deadlineMs) && now >= cycle.deadlineMs) {
    reasons.push(`wall-clock budget exceeded (deadline ${new Date(cycle.deadlineMs).toISOString()})`);
  }

  // B2: a SEPARATE, generous backstop over guarded tool calls — never cycle.turnLimit (loop iterations).
  // m2: only bump/persist when a toolCallLimit is configured. m3: Number() coercion (a string count must
  // not concatenate). The dispatcher guards Bash/PowerShell/Read/Grep/Glob/Write/Edit/MultiEdit/mcp__ calls,
  // so the backstop counts those.
  let nextCycle = cycle;
  if (Number.isFinite(cycle.toolCallLimit)) {
    const nextCount = (Number(cycle.toolCalls) || 0) + 1;
    nextCycle = { ...cycle, toolCalls: nextCount };
    if (nextCount > cycle.toolCallLimit) {
      reasons.push(`tool-call budget exceeded (${nextCount}/${cycle.toolCallLimit} tool calls — runaway backstop, not the per-cycle turn budget)`);
    }
  }

  if (reasons.length) {
    const warn = writeCycleFile(loopStateDir(root), file, { ...nextCycle, blocked: true });
    if (warn) process.stderr.write(`${warn}\n`);
    return {
      deny:
        `LOOP BUDGET EXCEEDED — ${reasons.join("; ")}. This is the SINGLE stop signal for this cycle (one-shot — ` +
        `every tool call from here on is allowed so you can act on it, this one included next time). Wind the ` +
        `cycle down now: revert any uncommitted work (git reset --hard to the pre-attempt SHA), record the ` +
        `outcome in .loop-state/, run this loop's Report step (which clears the cycle via \`budget.mjs end\`), ` +
        `and end the cycle. Do not start new work.`,
    };
  }

  if (nextCycle !== cycle) {
    const warn = writeCycleFile(loopStateDir(root), file, nextCycle);
    if (warn) return { warn };
  }
  return undefined;
}
