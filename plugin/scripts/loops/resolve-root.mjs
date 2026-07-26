#!/usr/bin/env node
/**
 * resolve-root.mjs (loop pack, re-review M4) — the ONE canonical rule for
 * "what worktree does this loop-state file belong to", shared by
 * state.mjs, budget.mjs, and plugin/hooks/loop-budget-guard.mjs so a
 * writer and a reader can never silently disagree.
 *
 * Before this: three independent guesses —
 *   - budget.mjs / state.mjs defaultRoot() = CLAUDE_PROJECT_DIR || cwd
 *   - loop-budget-guard.mjs                = payload.cwd || CLAUDE_PROJECT_DIR || cwd
 *   - maple-lib.sh's gitignore helper      = git rev-parse --show-toplevel
 * Reproduced failure: CLAUDE_PROJECT_DIR set to the MAIN checkout while the
 * shell (and the Claude Code session) had cd'd into a worktree — budget.mjs
 * wrote `current-cycle.json` into the MAIN checkout (CLAUDE_PROJECT_DIR
 * won), the guard read `payload.cwd` (the worktree) and found nothing —
 * the guard silently never fired for that cycle.
 *
 * Fix: loop state belongs to the WORKTREE the loop is actually running in.
 * Resolve `git rev-parse --show-toplevel` from the best available starting
 * point (an explicit cwd, e.g. the hook payload's `cwd` or a caller's
 * `--root`, else CLAUDE_PROJECT_DIR, else process.cwd()) and use ITS
 * answer — the same source of truth maple-lib.sh already used. Documented
 * fallback: if that starting point isn't inside a git repo (or `git` isn't
 * on PATH), the starting point itself is returned unchanged — never throws,
 * matching every other loop-pack path's "fail open, don't block a normal
 * session" convention.
 *
 * Importable: resolveLoopRoot(preferredCwd?) -> absolute path string.
 * Callers that already know their own worktree root for certain (any
 * maple-lib.sh-sourcing bash script, which computes MAPLE_REPO_ROOT via
 * this exact same `git rev-parse --show-toplevel` at step 0) should pass
 * `--root "$MAPLE_REPO_ROOT"` explicitly rather than rely on this
 * resolving it a second time — see plugin/commands/*.md step 0.
 *
 * `preferredCwd` MUST be the caller's own best-known "where am I right
 * now" — the hook's payload.cwd, or a CLI's own process.cwd() — NEVER
 * CLAUDE_PROJECT_DIR. CLAUDE_PROJECT_DIR is only the fallback for when
 * that's unavailable (e.g. a hook payload missing `cwd`), by design: it's
 * an env var set once when a session starts and does NOT update when the
 * session cd's into a worktree — trusting it over the actual current
 * location is exactly the bug this fix closes (budget.mjs's own CLI
 * default used to be `CLAUDE_PROJECT_DIR || cwd`, CLAUDE_PROJECT_DIR
 * winning; the guard's was `payload.cwd || CLAUDE_PROJECT_DIR || cwd`,
 * payload.cwd winning — two different priorities, hence the disagreement).
 * Every one of this module's own callers therefore passes its most
 * current cwd explicitly rather than calling `resolveLoopRoot()` bare.
 */
import { execFileSync } from "node:child_process";

/**
 * @param {string} [preferredCwd] the best-known starting point (e.g. a hook
 *   payload's `cwd`, or an explicit --root); falls back to
 *   CLAUDE_PROJECT_DIR, then process.cwd() when omitted/empty.
 * @returns {string} the git worktree toplevel containing that starting
 *   point, or the starting point itself if it isn't inside a git repo (or
 *   git isn't available) — never throws.
 */
export function resolveLoopRoot(preferredCwd) {
  const start = preferredCwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  try {
    const out = execFileSync("git", ["-C", start, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return out;
  } catch {
    /* `start` isn't inside a git repo, or git isn't on PATH — fall back to
       the plain candidate, same as before this fix existed. */
  }
  return start;
}
