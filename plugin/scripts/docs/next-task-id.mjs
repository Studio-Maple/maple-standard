#!/usr/bin/env node
/**
 * next-task-id.mjs (canonical, plugin-bundled — docs/decisions.md D010,
 * docs/tasks.md #T13) — collision-free ID allocator for #T tasks, D
 * decisions, and S sessions.
 *
 * Parallel sessions (or parallel agents) guessing "the next number" causes
 * real collisions. Allocate from here instead. Paths come from
 * maple.config.json `docs.tasks` / `docs.decisions` / `docs.log` (see
 * lib/config.mjs) — defaults match this template's flat docs/ layout.
 *
 *   node next-task-id.mjs              -> next free #T id + any #T collisions
 *   node next-task-id.mjs --decision   -> next free D id (docs.decisions)
 *   node next-task-id.mjs --session     -> next free S id (docs.log)
 *   node next-task-id.mjs --check       -> exit 1 if any #T collision (gate use)
 *
 *   node next-task-id.mjs --add --section "Inbox" --title "…" --body "…"
 *       -> allocate the next #T, insert `- [ ] **#T### — <title>.** <body>` at the
 *          TOP of the named docs.tasks section, print the allocated id.
 *   node next-task-id.mjs --add --decision --title "…" --body "…"
 *       -> allocate the next D, insert `## D### | YYYY-MM-DD | <title>` + body at the
 *          TOP of docs.decisions (newest-first, right after the preamble), print the id.
 *   node next-task-id.mjs --add --session --title "…" --body "…"
 *       -> allocate the next S, prepend `## S### | YYYY-MM-DD | <title>` + body at the
 *          TOP of docs.log (newest-first session log), print the id.
 *
 * IDs are REPO-GLOBAL, not per-worktree (docs/decisions.md D050). The number is one
 * past the highest of (a) a counter shared by every worktree via the git common dir
 * and (b) a live scan of every worktree's docs file — so two parallel `agent/<slug>`
 * sessions can't both hand out `#T42` off their own branch-local tasks.md. See
 * lib/id-store.mjs. Outside a git repo (or with MAPLE_ID_SHARED=0) it degrades to the
 * old single-worktree behaviour rather than failing.
 *
 * `--add` is ATOMIC vs parallel sessions: the allocate->write critical section runs
 * under an O_EXCL lockfile mutex — held in the git common dir, so it serialises
 * ACROSS worktrees and not just within one. Two concurrent invocations anywhere in
 * the repo can never hand out the same number. It is also the FORMAT GATE — it
 * refuses (nonzero exit, nothing
 * written) when the assembled entry block would exceed 600 chars (the cap
 * check-docs-drift.mjs errors on), when the named tasks section doesn't exist, or
 * when title/body are missing. The agent authors the content; the script only
 * allocates, formats, validates, places, prints.
 *
 * Test-only env overrides (so tests run against fixtures, never the real docs):
 *   NEXT_TASK_ID_TASKS_FILE      — path to a tasks.md fixture
 *   NEXT_TASK_ID_DECISIONS_FILE  — path to a decisions.md fixture
 *   NEXT_TASK_ID_LOG_FILE        — path to a log.md fixture
 *   NEXT_TASK_ID_TODAY           — YYYY-MM-DD to stamp decisions/sessions with
 *   MAPLE_ID_STORE_DIR           — override the shared counter/lock dir
 *   MAPLE_ID_SHARED=0            — disable the shared store (single-worktree mode)
 *
 * maple.config.json keys read: docs.tasks docs.decisions docs.log
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { open as fsOpen, stat as fsStat, unlink as fsUnlink, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveDocsConfig, defaultRoot } from "./lib/config.mjs";
import { resolveStoreDir, lockPath as sharedLockPath, nextGlobalId, writeCounter } from "./lib/id-store.mjs";

export const MAX_ENTRY_CHARS = 600; // matches check-docs-drift.mjs (ERROR over 600)

/** Resolve the doc paths for `root`, honouring the test-only env overrides (via lib/config.mjs). */
export function resolvePaths(env = process.env, root = defaultRoot()) {
  const cfg = resolveDocsConfig(root, env);
  return { tasks: cfg.tasks, decisions: cfg.decisions, log: cfg.log };
}

function read(p) {
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function allNums(text, prefix) {
  return [...text.matchAll(new RegExp(`${prefix}(\\d+)`, "g"))].map((m) => +m[1]);
}
function defCounts(text, lineRe) {
  const counts = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(lineRe);
    if (m) counts.set(+m[1], (counts.get(+m[1]) || 0) + 1);
  }
  return counts;
}

export function nextTaskNum(tasksTxt) {
  return Math.max(0, ...allNums(tasksTxt, "#T")) + 1;
}
export function nextDecisionNum(decisionsTxt) {
  return Math.max(0, ...allNums(decisionsTxt, "D")) + 1;
}
export function nextSessionNum(logTxt) {
  const nums = [...logTxt.matchAll(/^## S(\d+)\b/gm)].map((m) => +m[1]);
  return Math.max(0, ...nums) + 1;
}
export function taskCollisions(tasksTxt) {
  const defs = defCounts(tasksTxt, /^- \[ \][^#]*#T(\d+)/); // OPEN tasks only
  return [...defs].filter(([, n]) => n > 1).map(([id]) => id);
}

const padD = (n) => "D" + String(n).padStart(3, "0");
const padS = (n) => "S" + String(n).padStart(3, "0");

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatTaskEntry(num, title, body) {
  const t = String(title).trim().replace(/\.$/, "");
  return `- [ ] **#T${num} — ${t}.** ${String(body).trim()}`;
}
export function formatDatedEntry(id, date, title, body) {
  return `## ${id} | ${date} | ${String(title).trim()}\n${String(body).trim()}`;
}
export { formatDatedEntry as formatDecisionEntry };

// ── Validation ─────────────────────────────────────────────────────────────

class AllocError extends Error {}
export { AllocError };

export function validateEntry({ kind, block, title, body, section, tasksTxt }) {
  if (!title || !String(title).trim()) throw new AllocError("--title is required and must be non-empty");
  if (!body || !String(body).trim()) throw new AllocError("--body is required and must be non-empty");
  if (kind === "task") {
    if (!section || !String(section).trim()) throw new AllocError('--section is required for a task (e.g. --section "Inbox")');
    if (!findSectionHeader(tasksTxt, section)) {
      throw new AllocError(
        `section "${section}" not found in tasks doc. Existing sections: ${listSections(tasksTxt).join(", ")}`
      );
    }
  }
  if (block.length > MAX_ENTRY_CHARS) {
    throw new AllocError(
      `assembled ${kind} entry is ${block.length} chars (cap ${MAX_ENTRY_CHARS}) — the drift gate ERRORs over ${MAX_ENTRY_CHARS} chars. Trim the body; detail belongs in the owning doc/CHANGELOG/code.`
    );
  }
}

// ── Insertion ────────────────────────────────────────────────────────────────

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");

export function listSections(tasksTxt) {
  return [...tasksTxt.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
}
function findSectionHeader(tasksTxt, section) {
  return new RegExp(`^## ${escapeRe(String(section).trim())}\\s*$`, "m").exec(tasksTxt);
}

export function insertTaskEntry(tasksTxt, section, entryLine) {
  const m = findSectionHeader(tasksTxt, section);
  if (!m) throw new AllocError(`section "${section}" not found in tasks doc`);
  const eol = eolOf(tasksTxt);
  let pos = m.index + m[0].length;
  while (pos < tasksTxt.length && (tasksTxt[pos] === "\n" || tasksTxt[pos] === "\r")) pos++;
  return tasksTxt.slice(0, pos) + entryLine + eol + eol + tasksTxt.slice(pos);
}

export function insertDatedEntry(text, entryBlock, headerRe) {
  const eol = eolOf(text);
  const m = headerRe.exec(text);
  if (m) {
    return text.slice(0, m.index) + entryBlock + eol + eol + text.slice(m.index);
  }
  const sep = text.endsWith("\n") ? "" : eol;
  return text + sep + eol + entryBlock + eol;
}
export function insertDecisionEntry(decisionsTxt, entryBlock) {
  return insertDatedEntry(decisionsTxt, entryBlock, /^## D\d+\b/m);
}
export function insertSessionEntry(logTxt, entryBlock) {
  return insertDatedEntry(logTxt, entryBlock, /^## S\d+\b/m);
}

// ── Lockfile mutex (O_EXCL create + retry/backoff + stale steal) ──────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function acquireLock(lockPath, { timeoutMs = 5000, staleMs = 10000, retryMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fh = await fsOpen(lockPath, "wx");
      await fh.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await fh.close();
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const st = await fsStat(lockPath);
        if (Date.now() - st.mtimeMs > staleMs) {
          await fsUnlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new AllocError(`could not acquire lock ${lockPath} within ${timeoutMs}ms (another allocation is in flight)`);
      }
      await delay(retryMs + Math.floor(Math.random() * retryMs));
    }
  }
}

export async function releaseLock(lockPath) {
  await fsUnlink(lockPath).catch(() => {});
}

// ── Allocate-and-insert (the atomic core) ────────────────────────────────────

export async function allocateAndInsert({ kind, section, title, body, paths, env = process.env, root = defaultRoot(), lockOpts } = {}) {
  const file = kind === "decision" ? paths.decisions : kind === "session" ? paths.log : paths.tasks;

  // The mutex lives with the shared counter (git common dir) so it
  // serialises across every worktree of the repo. `${file}.lock` is the
  // documented fallback when there is no shared store — it only ever
  // guards this one worktree, which is all a non-git checkout has.
  const storeDir = resolveStoreDir(root, env);
  let lock = `${file}.lock`;
  if (storeDir) {
    try {
      mkdirSync(storeDir, { recursive: true });
      lock = sharedLockPath(storeDir, kind);
    } catch {
      /* .git unwritable — keep the local lock, still allocate off the scan */
    }
  }

  await acquireLock(lock, lockOpts);
  try {
    const text = existsSync(file) ? await fsReadFile(file, "utf8") : "";
    const localMax = kind === "session" ? nextSessionNum(text) - 1 : kind === "decision" ? nextDecisionNum(text) - 1 : nextTaskNum(text) - 1;
    const num = await nextGlobalId(kind, root, { storeDir, localMax });

    if (kind === "decision" || kind === "session") {
      const id = kind === "session" ? padS(num) : padD(num);
      const date = env.NEXT_TASK_ID_TODAY || new Date().toISOString().slice(0, 10);
      const block = formatDatedEntry(id, date, title, body);
      validateEntry({ kind, block, title, body });
      const insert = kind === "session" ? insertSessionEntry : insertDecisionEntry;
      await fsWriteFile(file, insert(text, block), "utf8");
      // After the doc write, never before: a counter bumped ahead of a
      // failed write burns ids, which is ugly but harmless — a counter
      // bumped for a write that never happened while another worktree is
      // mid-allocation is not.
      await writeCounter(storeDir, kind, num);
      return id;
    }

    const entryLine = formatTaskEntry(num, title, body);
    validateEntry({ kind: "task", block: entryLine, title, body, section, tasksTxt: text });
    await fsWriteFile(file, insertTaskEntry(text, section, entryLine), "utf8");
    await writeCounter(storeDir, kind, num);
    return `#T${num}`;
  } finally {
    await releaseLock(lock);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { add: false, decision: false, session: false, check: false, section: null, title: null, body: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--add") out.add = true;
    else if (a === "--decision") out.decision = true;
    else if (a === "--session") out.session = true;
    else if (a === "--check") out.check = true;
    else if (a === "--section") out.section = argv[++i];
    else if (a === "--title") out.title = argv[++i];
    else if (a === "--body") out.body = argv[++i];
    // --root: name the worktree explicitly rather than inferring it. Callers
    // that already know it (any maple-lib.sh script has $MAPLE_REPO_ROOT)
    // should pass it — CLAUDE_PROJECT_DIR is set once at session start and
    // does NOT follow a cd into a worktree. Same convention as the loop
    // pack's resolve-root.mjs.
    else if (a === "--root") out.root = argv[++i];
    else throw new AllocError(`unknown argument: ${a}`);
  }
  if (out.decision && out.session) throw new AllocError("--decision and --session are mutually exclusive");
  return out;
}

export async function run(argv, deps = {}) {
  try {
    return await dispatch(argv, deps);
  } catch (err) {
    if (err instanceof AllocError) return { stdout: "", stderr: err.message, exitCode: 1 };
    throw err;
  }
}

async function dispatch(argv, { env = process.env, root } = {}) {
  const opts = parseArgs(argv);
  // Precedence: --root (the caller KNOWS its worktree) > an embedding
  // caller's `root` (the template's scripts/next-task-id.mjs wrapper) >
  // defaultRoot().
  const effectiveRoot = opts.root ? resolve(opts.root) : root || defaultRoot();
  const paths = resolvePaths(env, effectiveRoot);

  if (opts.add) {
    const kind = opts.decision ? "decision" : opts.session ? "session" : "task";
    const id = await allocateAndInsert({ kind, section: opts.section, title: opts.title, body: opts.body, paths, env, root: effectiveRoot });
    const where = kind === "decision" ? paths.decisions : kind === "session" ? paths.log : `"${opts.section}" in ${paths.tasks}`;
    return { stdout: id, stderr: `Allocated ${id} -> inserted at top of ${where}`, exitCode: 0 };
  }

  if (opts.check) {
    // Local-only, deliberately. Two worktrees BOTH holding #T7 is normal —
    // they branched from a main that already had it — so a cross-worktree
    // duplicate scan would be almost entirely false positives. The
    // cross-worktree guarantee comes from allocation (id-store.mjs), not
    // from after-the-fact detection.
    const cols = taskCollisions(read(paths.tasks));
    if (cols.length) {
      return { stdout: "", stderr: `#T collisions (defined >1x): ${cols.map((n) => "#T" + n).join(", ")}`, exitCode: 1 };
    }
    return { stdout: "No #T collisions.", stderr: "", exitCode: 0 };
  }

  // The read-only queries report the same REPO-GLOBAL number --add would
  // allocate — a preview that disagreed with the allocator is worse than no
  // preview, since it is exactly what a hand-guessing agent copies.
  if (opts.decision) {
    const n = await nextGlobalId("decision", effectiveRoot, { localMax: nextDecisionNum(read(paths.decisions)) - 1 });
    return { stdout: padD(n), stderr: "", exitCode: 0 };
  }

  if (opts.session) {
    const n = await nextGlobalId("session", effectiveRoot, { localMax: nextSessionNum(read(paths.log)) - 1 });
    return { stdout: padS(n), stderr: "", exitCode: 0 };
  }

  const tasksTxt = read(paths.tasks);
  const cols = taskCollisions(tasksTxt);
  const stdout = "Next free task id: #T" + (await nextGlobalId("task", effectiveRoot, { localMax: nextTaskNum(tasksTxt) - 1 }));
  if (cols.length) {
    return {
      stdout,
      stderr: `\nWARN #T collisions (defined >1x): ${cols.map((n) => "#T" + n).join(", ")} — renumber before they bite.`,
      exitCode: 1,
    };
  }
  return { stdout, stderr: "", exitCode: 0 };
}

function isMain() {
  if (!process.argv[1]) return false;
  const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  return import.meta.url === argvUrl;
}

async function main() {
  let result;
  try {
    result = await run(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  if (result.stdout) process.stdout.write(result.stdout + "\n");
  if (result.stderr) process.stderr.write(result.stderr + "\n");
  process.exit(result.exitCode);
}

if (isMain()) {
  main();
}
