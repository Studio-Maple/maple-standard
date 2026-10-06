// Guards for shared-shell hazards (Bash + PowerShell). Part of the D065 dispatcher.
//
// cwd-guard: the shell's working directory persists across calls, including PARALLEL calls in one
//   message — a package-manager command without its own absolute `cd` can silently run in a sibling
//   workspace. Scoped to cwd-fragile npm/npx/yarn/pnpm. Paths are normalised (`/c/x`, `C:/x`, `C:\x`).
// push-guard: a project's pre-push gate can outlive the 2-minute default tool timeout; a foreground
//   `git push` gets killed mid-gate. Require run_in_background or a timeout above the minimum.
// clean-guard: `git clean` with DOUBLE force deletes nested git repos — the parallel-session worktrees,
//   whose node_modules junctions then get followed into the main checkout (D012).
// install-guard (D064): `pnpm|npm|yarn|bun add <pkg>@<version>` behind the latest major is denied
//   (registry lookup, ~4 s, fail-open with a warning; exceptions via maple.config.json deps.exceptions).
//
// maple.config.json hooks.bashGuard.{cwdGuardEnabled,pushGuardEnabled,pushGuardMinTimeoutMs,cleanGuardEnabled}.
import { gitInfo, inspectableArgs, isAbsPath } from "./shell.mjs";

const PKG_MANAGERS = new Set(["npm", "npx", "yarn", "pnpm"]);
const ANCHOR_FLAGS = new Set(["--prefix", "--cwd", "--dir", "-C"]);
const DEFAULT_PUSH_MIN_TIMEOUT_MS = 600_000;

function anchoredByFlag(seg) {
  const a = seg.args;
  for (let n = 0; n < a.length; n++) {
    const t = a[n].text;
    const eq = t.indexOf("=");
    if (eq > 0 && ANCHOR_FLAGS.has(t.slice(0, eq)) && isAbsPath(t.slice(eq + 1))) return true;
    if (ANCHOR_FLAGS.has(t) && a[n + 1] && isAbsPath(a[n + 1].text)) return true;
  }
  return false;
}

/** Count force flags in `git clean` args: each `--force`, plus every `f` in a short cluster. Stops at `--`. */
function countForce(args) {
  let n = 0;
  for (const a of args) {
    if (a.text === "--") break;
    if (a.text === "--force") n += 1;
    else if (/^-[A-Za-z]+$/.test(a.text)) n += (a.text.match(/f/g) || []).length;
  }
  return n;
}

function rebuild(segs) {
  const q = (t) => (/[\s"'`]/.test(t) ? `"${t.replace(/"/g, "")}"` : t);
  return segs
    .filter((s) => !["echo", "printf"].includes(s.verb))
    .map((s) => [s.verb, ...inspectableArgs(s).map((w) => q(w.text))].join(" "))
    .join(" ; ");
}

export async function check(ctx) {
  const cfg = ctx.config().cfg?.hooks?.bashGuard ?? {};
  const cwdGuard = cfg.cwdGuardEnabled !== false;
  const pushGuard = cfg.pushGuardEnabled !== false;
  const cleanGuard = cfg.cleanGuardEnabled !== false;
  const minTimeout = Number(cfg.pushGuardMinTimeoutMs) || DEFAULT_PUSH_MIN_TIMEOUT_MS;
  const segs = ctx.segments();

  for (const seg of segs) {
    if (cwdGuard && PKG_MANAGERS.has(seg.verb) && !seg.anchored && !anchoredByFlag(seg)) {
      return {
        deny:
          "BLOCKED (cwd-guard): package-manager commands must anchor their own directory — the shell cwd persists across " +
          "calls (parallel calls included) and may not be where you think. Re-issue as `cd <absolute path> && " +
          ctx.command.slice(0, 60).trim() + " …`.",
      };
    }
    const g = gitInfo(seg);
    if (!g) continue;
    if (cleanGuard && g.sub === "clean" && countForce(inspectableArgs(seg).filter((a) => g.args.includes(a))) >= 2) {
      return {
        deny:
          "BLOCKED (clean-guard): `git clean` with double force (-ff / --force --force) deletes NESTED GIT REPOSITORIES — which means " +
          "this repo's parallel-session worktrees (`.worktrees/`).\n" +
          "  Verified: `git clean -xfd` prints \"Skipping repository .worktrees/<slug>\" and is safe; `git clean -xffd` takes every worktree with it.\n" +
          "  A worktree also holds node_modules/.next JUNCTIONS into the MAIN checkout and the recursive delete follows them (D012).\n" +
          "  Drop one -f. To remove a worktree use `git worktree remove` or `/wt-reap`. (Disable via maple.config.json hooks.bashGuard.cleanGuardEnabled=false.)",
      };
    }
    if (pushGuard && g.sub === "push") {
      const input = ctx.input;
      const timeoutOk = typeof input.timeout === "number" && input.timeout >= minTimeout;
      if (input.run_in_background !== true && !timeoutOk) {
        return {
          deny:
            "BLOCKED (push-guard): this project's pre-push gate can reliably outlive the 2-minute default timeout and the push gets killed " +
            `mid-gate. Re-issue with run_in_background: true (preferred — you are notified on completion) or timeout: ${minTimeout}. ` +
            "(Disable via maple.config.json hooks.bashGuard.pushGuardEnabled=false if this project's push has no slow gate.)",
        };
      }
    }
  }

  // install-guard (D064): fail-open on any error — a broken guard must not block unrelated shell calls.
  const command = rebuild(segs);
  if (!/\b(pnpm|npm|yarn|bun)\b/.test(command)) return undefined;
  try {
    const { checkInstallCommand } = await import("../../scripts/deps/install-guard.mjs");
    const { deny, warnings } = await checkInstallCommand(command, ctx.config().root || ctx.cwd);
    if (deny) return { deny: `BLOCKED (dep-freshness): ${deny}` };
    if (warnings.length) return { warn: warnings.join("\n") };
  } catch (err) {
    return { warn: `dep-freshness: guard error ignored (${err instanceof Error ? err.message : err})` };
  }
  return undefined;
}
