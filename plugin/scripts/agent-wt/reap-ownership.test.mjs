#!/usr/bin/env node
/**
 * reap-ownership.test.mjs — regression test for maple-reap.sh deleting
 * worktrees it does not own.
 *
 * Incident (2026-09-16, MapleLens): a session kept a worktree of `main` itself
 * at `.worktrees/main` as its merge base. `maple-reap` saw a worktree under
 * worktrees.root whose branch was "merged into origin/main" — trivially true
 * for `main` — and deleted the worktree AND the local `main` branch. A local
 * app running from that directory lost its build output.
 *
 * Root cause: pass 1 treated "path is under worktrees.root" as proof of
 * ownership. That held while the root was a sibling `<repo>-wt` dir only our
 * scripts wrote to; since D055 moved it inside the repo, anyone parks worktrees
 * there. Ownership now comes from the branch name. The same pass also removed
 * every DETACHED worktree unconditionally — dirty trees and commits reachable
 * from no branch included.
 *
 * Builds a repo + bare origin with:
 *   .worktrees/main          branch main          (protected)       -> KEPT
 *   .worktrees/feature-x     branch feature/x     (merged, foreign) -> KEPT
 *   .worktrees/done          branch agent/done    (merged, ours)    -> REMOVED
 *   .worktrees/wip           branch agent/wip     (unmerged, ours)  -> KEPT
 *   .worktrees/det-clean     detached, clean, merged                -> REMOVED
 *   .worktrees/det-dirty     detached, uncommitted change           -> KEPT
 *   .worktrees/det-unmerged  detached, commit on no branch          -> KEPT
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const posixish = (p) => p.replaceAll("\\", "/");
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

if (sh("bash", ["-c", "echo ok"]).status !== 0) {
  console.log("SKIP: bash not on PATH — the agent-wt scripts (and this test) need it.");
  process.exit(0);
}

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

// realpath: on Windows os.tmpdir() can be an 8.3 short path (C:\Users\ABCDEF~1)
// while `git worktree list` prints the long one, so reap's path-prefix match
// would never fire and every "survives" assertion would pass vacuously.
const sb = realpathSync.native(mkdtempSync(join(tmpdir(), "maple-reap-own-")));
const origin = join(sb, "origin.git");
const repo = join(sb, "repo");
const wt = (n) => join(repo, ".worktrees", n);
const git = (args, cwd = repo) => {
  const r = sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};

try {
  sh("git", ["init", "-q", "--bare", "-b", "main", origin]);
  sh("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  git(["remote", "add", "origin", origin]);

  // Branches that are merged: created at main's tip, so contained in origin/main.
  git(["branch", "agent/done"]);
  git(["branch", "feature/x"]);
  git(["push", "-q", "origin", "main"]);

  // An unmerged agent branch: one commit beyond main.
  git(["checkout", "-q", "-b", "agent/wip"]);
  git(["commit", "-q", "--allow-empty", "-m", "unlanded work"]);
  git(["checkout", "-q", "main"]);

  // The main checkout must not hold `main` or the worktree of it can't exist.
  git(["checkout", "-q", "--detach"]);

  git(["worktree", "add", "-q", wt("main"), "main"]);
  git(["worktree", "add", "-q", wt("feature-x"), "feature/x"]);
  git(["worktree", "add", "-q", wt("done"), "agent/done"]);
  git(["worktree", "add", "-q", wt("wip"), "agent/wip"]);
  git(["worktree", "add", "-q", "--detach", wt("det-clean"), "main"]);
  git(["worktree", "add", "-q", "--detach", wt("det-dirty"), "main"]);
  writeFileSync(join(wt("det-dirty"), "uncommitted.txt"), "work in progress\n");
  git(["worktree", "add", "-q", "--detach", wt("det-unmerged"), "main"]);
  git(["commit", "-q", "--allow-empty", "-m", "commit on no branch"], wt("det-unmerged"));

  const r = sh("bash", [posixish(join(HERE, "maple-reap.sh"))], { cwd: repo });
  const out = `${r.stdout}\n${r.stderr}`;
  check("maple-reap exits 0", r.status === 0, r.status === 0 ? "" : out.slice(-600));

  const branches = git(["branch", "--format=%(refname:short)"]).split("\n");
  check("protected branch `main` survives", branches.includes("main"), branches.join(", "));
  check("worktree of `main` survives", existsSync(wt("main")));
  check("foreign-prefix merged worktree survives", existsSync(wt("feature-x")));
  check("foreign-prefix merged branch survives", branches.includes("feature/x"));
  check("unmerged agent worktree survives", existsSync(wt("wip")));
  check("merged agent worktree is reaped", !existsSync(wt("done")));
  check("merged agent branch is reaped", !branches.includes("agent/done"));
  check("clean merged detached worktree is reaped", !existsSync(wt("det-clean")));
  check("dirty detached worktree survives", existsSync(join(wt("det-dirty"), "uncommitted.txt")));
  check("detached worktree with unreachable commit survives", existsSync(wt("det-unmerged")));
  check("reap reports protected keep", /protected branch, never reaped/.test(out));
} finally {
  // Worktrees must be detached from git before the sandbox dir goes.
  sh("git", ["worktree", "prune"], { cwd: repo });
  rmSync(sb, { recursive: true, force: true });
}

if (failed) {
  console.log(`\nreap-ownership: ${failed} assertion(s) FAILED.`);
  process.exit(1);
}
console.log("\nreap-ownership: all assertions passed.");
