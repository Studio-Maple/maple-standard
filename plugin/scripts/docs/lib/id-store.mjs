#!/usr/bin/env node
/**
 * id-store.mjs — the REPO-GLOBAL high-water mark behind next-task-id.mjs.
 *
 * The problem it closes: next-task-id.mjs used to allocate from
 * `max(ids in THIS worktree's docs/tasks.md) + 1`, and serialised on
 * `docs/tasks.md.lock` — a path that is *also* per-worktree. Two parallel
 * sessions in two `agent/<slug>` worktrees therefore both scanned a
 * branch-local tasks.md, both saw `#T41` as the highest, and both handed
 * out `#T42`. The lockfile never noticed: each worktree had its own lock.
 * The collision only surfaced at /wt-land, after both branches were
 * already written.
 *
 * The fix has two halves, and needs both:
 *
 *   1. A COUNTER shared by every worktree of the repo, living in the git
 *      COMMON dir (`git rev-parse --git-common-dir` — the main checkout's
 *      `.git`, which every linked worktree resolves to the same absolute
 *      path). Uncommitted, so it never merges or conflicts; machine-local,
 *      which is the right scope — worktrees are a local construct.
 *   2. A LIVE SCAN of every worktree's docs file (`git worktree list`),
 *      because the counter can be behind: it doesn't exist yet on first
 *      run, a fresh clone starts empty, and a branch may carry ids that
 *      were allocated before this mechanism shipped.
 *
 * The allocated number is `max(counter, every worktree's scan) + 1`, and
 * the lock lives in the common dir too — so the mutex is finally
 * repo-wide rather than worktree-wide.
 *
 * Fail-open, always: a non-git directory, a missing `git`, an unreadable
 * or corrupt counter file all degrade to plain single-worktree behaviour
 * (scan the local doc, lock next to it) rather than blocking an
 * allocation. Losing the shared counter costs you collision-freedom
 * across worktrees, which is exactly where you were before — it must
 * never cost you the ability to file a task.
 *
 * Env overrides:
 *   MAPLE_ID_STORE_DIR      — use this dir for the counter + lock instead of
 *                             the git common dir (tests; also an escape hatch
 *                             for a repo whose .git is read-only).
 *   MAPLE_ID_SHARED=0       — disable the shared store entirely; behave exactly
 *                             as before this module existed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readFile as fsReadFile, writeFile as fsWriteFile, rename as fsRename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveDocsConfig } from "./config.mjs";

/** The three id namespaces, and which resolved docs.* file each is scanned from. */
export const KINDS = {
  task: { docKey: "tasks", pattern: /#T(\d+)/g },
  // Deliberately the same loose patterns next-task-id.mjs's own
  // nextTaskNum/nextDecisionNum/nextSessionNum use. A stricter regex here
  // could read a LOWER max out of a sibling worktree than that worktree's
  // own allocator would, which is the one direction that reintroduces
  // collisions.
  decision: { docKey: "decisions", pattern: /D(\d+)/g },
  session: { docKey: "log", pattern: /^## S(\d+)\b/gm },
};

function git(args, cwd) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * The directory holding the repo-global counter + lock, or null when there
 * isn't one (not a git repo, no git on PATH, or explicitly disabled).
 * `git rev-parse --git-common-dir` answers with the MAIN checkout's `.git`
 * from inside any linked worktree — that shared answer is the whole point.
 * It may come back relative (plain `.git` in the main checkout), hence the
 * resolve() against `root`.
 */
export function resolveStoreDir(root, env = process.env) {
  if (env.MAPLE_ID_SHARED === "0") return null;
  if (env.MAPLE_ID_STORE_DIR) return resolve(env.MAPLE_ID_STORE_DIR);
  let commonDir;
  try {
    commonDir = git(["rev-parse", "--git-common-dir"], root);
  } catch {
    return null; // not a git repo, or git isn't installed — fail open
  }
  if (!commonDir) return null;
  return join(resolve(root, commonDir), "maple");
}

export const counterPath = (storeDir) => join(storeDir, "id-counters.json");
export const lockPath = (storeDir, kind) => join(storeDir, `id-alloc-${kind}.lock`);

/**
 * Every worktree root of this repo, current one first. A single-element
 * array (just `root`) when git can't answer — the caller then behaves
 * exactly as the pre-shared-store allocator did.
 */
export function listWorktreeRoots(root) {
  let out;
  try {
    out = git(["worktree", "list", "--porcelain"], root);
  } catch {
    return [resolve(root)];
  }
  const roots = [...out.matchAll(/^worktree (.+)$/gm)].map((m) => resolve(m[1].trim()));
  const here = resolve(root);
  const rest = roots.filter((p) => p !== here);
  return [here, ...rest];
}

function maxIdIn(text, pattern) {
  let max = 0;
  for (const m of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
    const n = +m[1];
    if (n > max) max = n;
  }
  return max;
}

/**
 * Highest `kind` id present in ANY worktree's docs file.
 *
 * Each worktree is resolved through its OWN maple.config.json — a worktree
 * on a branch that moved `docs.tasks` still gets scanned at the right path.
 * The test-only NEXT_TASK_ID_*_FILE overrides are deliberately NOT applied
 * to sibling worktrees: they name one fixture, and replaying it per
 * worktree would just re-scan the same file.
 */
export function scanWorktrees(kind, root, { worktreeRoots } = {}) {
  const { docKey, pattern } = KINDS[kind];
  const roots = worktreeRoots || listWorktreeRoots(root);
  let max = 0;
  for (const wt of roots) {
    let file;
    try {
      file = resolveDocsConfig(wt, {})[docKey];
    } catch {
      continue;
    }
    if (!file || !existsSync(file)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // a worktree on a network drive that's gone, a permissions blip
    }
    const n = maxIdIn(text, pattern);
    if (n > max) max = n;
  }
  return max;
}

/** Read the shared counters. Any failure (missing, truncated, hand-edited) reads as empty. */
export async function readCounters(storeDir) {
  if (!storeDir) return {};
  try {
    const parsed = JSON.parse(await fsReadFile(counterPath(storeDir), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Persist `kind`'s last-allocated number. Written to a temp file and
 * renamed so a crash mid-write can't leave a truncated JSON behind (a
 * reader would treat that as empty and re-hand-out live ids).
 *
 * Never throws: a read-only `.git` degrades to scan-only allocation, which
 * is still correct as long as the id reached a doc file.
 */
export async function writeCounter(storeDir, kind, value) {
  if (!storeDir) return false;
  try {
    mkdirSync(storeDir, { recursive: true });
    const current = await readCounters(storeDir);
    // max(), not assignment: a concurrent allocation for another `kind`
    // read-modify-writes this same file, and a stale number here would
    // silently re-issue live ids.
    const next = { ...current, [kind]: Math.max(Number(current[kind]) || 0, value) };
    const tmp = `${counterPath(storeDir)}.${process.pid}.tmp`;
    await fsWriteFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fsRename(tmp, counterPath(storeDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * The next free `kind` id: one past the highest of the shared counter and
 * every worktree's docs file. `localMax` is passed in by the caller, which
 * has already read the local file under the lock — it's included in the
 * scan too, but passing it keeps the answer correct even if the scan fails
 * outright.
 */
export async function nextGlobalId(kind, root, { storeDir, localMax = 0, worktreeRoots } = {}) {
  const dir = storeDir === undefined ? resolveStoreDir(root) : storeDir;
  const counters = await readCounters(dir);
  const fromCounter = Number(counters[kind]) || 0;
  const fromScan = scanWorktrees(kind, root, { worktreeRoots });
  return Math.max(localMax, fromScan, fromCounter) + 1;
}
