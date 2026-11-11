// Guard for file-writing tools (Write | Edit | MultiEdit | NotebookEdit, plus Bash/PowerShell `>`, `>>`
// and `tee` targets): a session writes only inside its own project. All work stays in the project's repo
// (on its branch), never in the desktop app's shared notes folder or a sibling folder of the repo.
//
// Allowed: the repo root of the session's cwd — the parent of git's COMMON dir, so every worktree of the
// repo (<repo>/.worktrees/*, <repo>/.claude/worktrees/*) counts — the OS temp dirs (the scratchpad lives
// there), ~/.claude (memory, settings), and maple.config.json `hooks.writeAllow` entries (absolute, or
// relative to the config's directory). A cwd outside any git repo has nothing to protect: allow.
//
// No git subprocess: the repo root is found by walking up to `.git` (a directory = main checkout; a file
// `gitdir: <common>/.git/worktrees/<n>` = linked worktree) and cached per cwd. Paths are compared after
// realpath of their nearest existing ancestor (expands 8.3 short names like MAAYAN~1) and, on Windows,
// case-insensitively with `/` and `\` unified. Anything unresolvable fails open.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { isAbsPath, normPath } from "./shell.mjs";

const WIN = process.platform === "win32";
const rootCache = new Map();

const key = (p) => { const n = normPath(p); return WIN ? n.toLowerCase() : n; };
const within = (p, root) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/** realpath of the nearest existing ancestor + the not-yet-existing tail; falls back to the input. */
export function realish(p) {
  const tail = [];
  let cur = resolve(p);
  for (;;) {
    try { return join(realpathSync.native(cur), ...tail.reverse()); } catch { /* keep climbing */ }
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    tail.push(basename(cur));
    cur = up;
  }
}

/** Repo root (parent of the git common dir) for `cwd`, or null when not inside a git repo. */
export function repoRootOf(cwd) {
  const start = realish(cwd);
  if (rootCache.has(start)) return rootCache.get(start);
  let found = null;
  for (let dir = start; ;) {
    const g = join(dir, ".git");
    if (existsSync(g)) {
      try {
        if (statSync(g).isDirectory()) { found = dir; break; }
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(g, "utf8"));
        const gitdir = m ? resolve(dir, m[1].trim()) : null;
        const wt = gitdir ? /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/i.exec(gitdir) : null;
        found = wt ? wt[1] : dir; // submodule / odd layout: this dir is the project
      } catch { found = null; }
      break;
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const root = found ? realish(found) : null;
  rootCache.set(start, root);
  return root;
}

function allowedRoots(root, ctx) {
  const roots = [root, tmpdir(), process.env.TEMP, process.env.TMP, process.env.TMPDIR, join(homedir(), ".claude")];
  if (!WIN) roots.push("/tmp");
  let conf = null;
  try { conf = ctx.config(); } catch { /* fail open on config trouble: just no extras */ }
  const base = conf?.root ?? root;
  const extra = conf?.cfg?.hooks?.writeAllow;
  if (Array.isArray(extra)) for (const e of extra) if (typeof e === "string" && e) roots.push(isAbsPath(e) ? e : resolve(base, e));
  return roots.filter(Boolean).flatMap((r) => { const rp = realish(r); return rp === r ? [key(r)] : [key(r), key(rp)]; });
}

function denyText(target, root) {
  const t = normPath(target);
  const where = /side-session-notes/i.test(t)
    ? "that is the desktop app's shared notes folder"
    : within(key(target), key(dirname(root))) ? "that is a sibling folder of the repo, not part of it" : "that is outside the project";
  return `Write blocked: ${t} — ${where}. All work stays inside the project's repo (${normPath(root)}): write it in your worktree/branch ` +
    `(e.g. docs/ or a folder in the repo) and commit it there. Temp files go in the OS temp dir / scratchpad. ` +
    `A deliberate exception: add the folder to maple.config.json hooks.writeAllow.`;
}

/** @returns {string|null} a deny reason when `target` (as given by the tool) may not be written. */
export function checkTarget(target, baseDir, ctx) {
  const sessionRoot = repoRootOf(ctx.cwd); // the SESSION's repo, even after a `cd` elsewhere in the command
  if (typeof target !== "string" || !target.trim()) return null;
  if (/[$`%]|\$\(|^\/dev\/|^nul$/i.test(target.trim())) return null; // unresolvable / device: cannot judge
  const abs = isAbsPath(target) ? target.replace(/^~(?=[\\/]|$)/, homedir()) : resolve(baseDir, target);
  const root = sessionRoot;
  if (!root) return null; // no repo, nothing to protect
  const real = key(realish(isAbsolute(abs) || isAbsPath(abs) ? normPath(abs) : abs));
  return allowedRoots(root, ctx).some((r) => within(real, r)) ? null : denyText(realish(abs), root);
}

const FILE_TOOLS = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

export function check(ctx) {
  const field = FILE_TOOLS[ctx.tool];
  if (field) {
    const reason = checkTarget(ctx.input?.[field] ?? ctx.input?.file_path, ctx.cwd, ctx);
    return reason ? { deny: reason } : undefined;
  }
  if (ctx.tool !== "Bash" && ctx.tool !== "PowerShell") return undefined;
  for (const seg of ctx.segments()) {
    const base = seg.cd ? resolve(ctx.cwd, String(seg.cd)) : ctx.cwd;
    const targets = seg.words.filter((w) => w.redir === ">" && !w.sub).map((w) => w.text);
    if (seg.verb === "tee") for (const a of seg.args) if (!a.redir && !a.sub && !a.text.startsWith("-")) targets.push(a.text);
    for (const t of targets) {
      const reason = checkTarget(t, base, ctx);
      if (reason) return { deny: reason };
    }
  }
  return undefined;
}
