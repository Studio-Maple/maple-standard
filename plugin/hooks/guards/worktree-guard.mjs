// Guard: worktree placement (D055/D065). `git worktree add <path>` is allowed only when the resolved path
// is a direct slot under <main-root>/.worktrees/ or <main-root>/.claude/worktrees/ and not inside another
// linked worktree. Sibling `<repo>-wt` dirs and worktrees nested in worktrees are denied. When the path
// cannot be resolved statically ($VAR, substitution) or the main root is unknown, warn and allow.
//
// main root = parent of `git rev-parse --git-common-dir` (the only spawn here, and only for
// `git worktree add`).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { gitInfo, inspectableArgs, isAbsPath, normPath } from "./shell.mjs";

const VALUE_FLAGS = new Set(["-b", "-B", "--reason"]);

/** Main checkout root for a repo directory, or null (bare repo / not a repo). */
export function mainRootOf(dir) {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return null;
  const common = normPath(resolve(dir, r.stdout.trim()));
  if (!common.endsWith("/.git")) return null;
  return common.slice(0, -"/.git".length);
}

/** Where `path` sits relative to the allowed worktree roots. */
export function classifyWorktreePath(path, mainRoot) {
  const p = normPath(path).toLowerCase();
  const main = mainRoot.toLowerCase();
  for (const sub of [".worktrees", ".claude/worktrees"]) {
    const base = `${main}/${sub}`;
    if (p === base) return { ok: false, why: `${sub} itself is the container, not a worktree` };
    if (p.startsWith(`${base}/`)) {
      const rest = p.slice(base.length + 1);
      if (rest.includes("/")) return { ok: false, why: "inside another worktree (nested worktrees are denied)" };
      return { ok: true };
    }
  }
  return { ok: false, why: "outside <main-root>/.worktrees/ and <main-root>/.claude/worktrees/" };
}

export function check(ctx) {
  for (const seg of ctx.segments()) {
    const g = gitInfo(seg);
    if (!g || g.sub !== "worktree") continue;
    const args = inspectableArgs(seg).filter((a) => g.args.includes(a));
    if (args[0]?.text !== "add") continue;
    let target = null;
    for (let n = 1; n < args.length; n++) {
      const t = args[n].text;
      if (VALUE_FLAGS.has(t)) { n++; continue; }
      if (t.startsWith("-")) continue;
      target = args[n];
      break;
    }
    if (!target) continue;
    const base = g.dir ? resolve(seg.cd || ctx.cwd, g.dir) : seg.cd || ctx.cwd;
    if (target.sub || /[$%]/.test(target.text)) {
      return { warn: `worktree-guard: could not resolve the worktree path "${target.text}" statically; it must be under <main-root>/.worktrees/.` };
    }
    const abs = isAbsPath(target.text) && !target.text.startsWith("~") ? target.text : resolve(base, target.text);
    const main = mainRootOf(base);
    if (!main) return { warn: "worktree-guard: could not determine the main checkout root; the worktree must be under <main-root>/.worktrees/." };
    const verdict = classifyWorktreePath(abs, main);
    if (!verdict.ok) {
      return {
        deny:
          `BLOCKED (worktree-guard): \`git worktree add ${target.text}\` — ${verdict.why}. Worktrees live ONLY at ${main}/.worktrees/<slug> (D055); ` +
          "use /wt-start, which creates them in the right place. Never a sibling `<repo>-wt` directory, never inside another worktree.",
      };
    }
  }
  return undefined;
}
