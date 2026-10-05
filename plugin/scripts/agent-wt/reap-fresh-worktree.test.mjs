#!/usr/bin/env node
/**
 * reap-fresh-worktree.test.mjs — regression test for maple-reap.sh destroying
 * uncommitted work.
 *
 * `git worktree add -b agent/x origin/<target>` has zero commits, so the branch
 * is trivially an ancestor of the target and reap's `is_merged` path ran
 * `maple_remove_worktree` (`git worktree remove --force`, then `rm -rf`) on it,
 * in-progress uncommitted edits included. Only the detached-HEAD path checked
 * `git status --porcelain`. `--force` (idle unmerged) had the same hole, and
 * `git worktree lock` was bypassed by the forced remove.
 *
 * One reap run with --force (default staleHours 24) over:
 *   fresh-dirty    agent/fresh-dirty   zero commits, uncommitted file   -> KEPT
 *   fresh-clean    agent/fresh-clean   zero commits, HEAD touched now   -> KEPT
 *   stale-ff       agent/stale-ff      at target tip, HEAD idle 48h     -> REMOVED (landed by fast-forward)
 *   landed-dirty   agent/landed-dirty  landed, then an uncommitted file -> KEPT
 *   landed-locked  agent/landed-locked landed, `git worktree lock`      -> KEPT
 *   idle-dirty     agent/idle-dirty    unmerged, idle 48h, dirty        -> KEPT under --force
 *   idle-clean     agent/idle-clean    unmerged, idle 48h, clean        -> worktree removed, branch kept
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

// realpath: see reap-ownership.test.mjs (8.3 short tmpdir vs git's long path).
const sb = realpathSync.native(mkdtempSync(join(tmpdir(), "maple-reap-fresh-")));
const origin = join(sb, "origin.git");
const repo = join(sb, "repo");
const wt = (n) => join(repo, ".worktrees", n);
const git = (args, cwd = repo, env = process.env) => {
  const r = sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};
const twoDaysAgo = Math.floor(Date.now() / 1000) - 48 * 3600;
const oldEnv = { ...process.env, GIT_AUTHOR_DATE: `@${twoDaysAgo}`, GIT_COMMITTER_DATE: `@${twoDaysAgo}` };
const backdateHeadReflog = (n) => {
  const gd = git(["rev-parse", "--absolute-git-dir"], wt(n));
  utimesSync(join(gd, "logs", "HEAD"), twoDaysAgo, twoDaysAgo);
};
const dirty = (n) => writeFileSync(join(wt(n), "uncommitted.txt"), "work in progress\n");

try {
  sh("git", ["init", "-q", "--bare", "-b", "main", origin]);
  sh("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  git(["remote", "add", "origin", origin]);

  // Landed branches: one commit each, merged into main with --no-ff.
  for (const b of ["landed-dirty", "landed-locked"]) {
    git(["checkout", "-q", "-b", `agent/${b}`, "main"]);
    git(["commit", "-q", "--allow-empty", "-m", `${b} work`]);
    git(["checkout", "-q", "main"]);
    git(["merge", "-q", "--no-ff", "-m", `land ${b}`, `agent/${b}`]);
  }
  // Unmerged, idle 48h.
  for (const b of ["idle-dirty", "idle-clean"]) {
    git(["checkout", "-q", "-b", `agent/${b}`, "main"]);
    git(["commit", "-q", "--allow-empty", "-m", `${b} work`], repo, oldEnv);
    git(["checkout", "-q", "main"]);
  }
  git(["push", "-q", "origin", "main"]);
  git(["fetch", "-q", "origin"]);
  git(["checkout", "-q", "--detach"]);

  // Fresh worktrees, created the way maple-start does: -b off origin/<target>.
  for (const b of ["fresh-dirty", "fresh-clean", "stale-ff"]) {
    git(["worktree", "add", "-q", "-b", `agent/${b}`, wt(b), "origin/main"]);
  }
  dirty("fresh-dirty");
  backdateHeadReflog("stale-ff");

  for (const b of ["landed-dirty", "landed-locked", "idle-dirty", "idle-clean"]) {
    git(["worktree", "add", "-q", wt(b), `agent/${b}`]);
  }
  dirty("landed-dirty");
  git(["worktree", "lock", "--reason", "test", wt("landed-locked")]);
  dirty("idle-dirty");

  const r = sh("bash", [posixish(join(HERE, "maple-reap.sh")), "--force"], { cwd: repo });
  const out = `${r.stdout}\n${r.stderr}`;
  check("maple-reap exits 0", r.status === 0, r.status === 0 ? "" : out.slice(-600));

  const branches = git(["branch", "--format=%(refname:short)"]).split("\n");
  check("fresh zero-commit worktree keeps its uncommitted file", existsSync(join(wt("fresh-dirty"), "uncommitted.txt")));
  check("fresh zero-commit branch survives", branches.includes("agent/fresh-dirty"));
  check("fresh clean worktree survives (HEAD touched within staleHours)", existsSync(wt("fresh-clean")));
  check("fresh clean branch survives", branches.includes("agent/fresh-clean"));
  check("stale worktree at target tip is reaped", !existsSync(wt("stale-ff")));
  check("stale branch at target tip is reaped", !branches.includes("agent/stale-ff"));
  check("landed worktree with uncommitted file survives", existsSync(join(wt("landed-dirty"), "uncommitted.txt")));
  check("locked landed worktree survives", existsSync(wt("landed-locked")));
  check("locked landed branch survives", branches.includes("agent/landed-locked"));
  check("--force keeps an idle unmerged worktree with uncommitted file", existsSync(join(wt("idle-dirty"), "uncommitted.txt")));
  check("--force still removes an idle clean unmerged worktree", !existsSync(wt("idle-clean")));
  check("--force keeps the idle clean branch", branches.includes("agent/idle-clean"));
  check("reap reports the uncommitted keep", /uncommitted changes in the worktree/.test(out));
  check("reap reports the fresh keep", /a fresh worktree/.test(out));
  check("reap reports the lock keep", /locked \(git worktree lock\)/.test(out));
} finally {
  sh("git", ["worktree", "unlock", wt("landed-locked")], { cwd: repo });
  sh("git", ["worktree", "prune"], { cwd: repo });
  rmSync(sb, { recursive: true, force: true });
}

if (failed) {
  console.log(`\nreap-fresh-worktree: ${failed} assertion(s) FAILED.`);
  process.exit(1);
}
console.log("\nreap-fresh-worktree: all assertions passed.");
