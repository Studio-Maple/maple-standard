#!/usr/bin/env node
/**
 * reap-dryrun.integration.test.mjs - maple-reap.sh --dry-run must be strictly read-only, and
 * --include-pi (opt-in) must reap merged pi/* worktrees + branches children-first through the same guards.
 *
 * Before this fix --dry-run still ran `git fetch` (moves origin/main) and `git worktree prune` (deletes
 * stale worktree admin dirs), so a "preview" mutated the repo.
 *
 * Repo + bare origin:
 *   origin has a NEWER main commit than the local origin/main ref   -> a dry-run fetch would move the ref
 *   .git/worktrees/gone     admin entry whose directory is deleted  -> a dry-run prune would delete it
 *   .worktrees/done         agent/done, landed                      -> would be removed
 *   .worktrees/pi-parent    pi/parent (older, merged)               -> only with --include-pi, AFTER pi/child
 *   .worktrees/pi-child     pi/child  (newer, merged)               -> only with --include-pi, FIRST
 *   .worktrees/pi-dirty     pi/dirty, merged but uncommitted change -> always kept
 *   .worktrees/pi-wip       pi/wip, unmerged commit                 -> always kept
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const posixish = (p) => p.replaceAll("\\", "/");
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

if (sh("bash", ["-c", "echo ok"]).status !== 0) {
  console.log("SKIP: bash not on PATH - the agent-wt scripts (and this test) need it.");
  process.exit(0);
}

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed++;
};

const sb = realpathSync.native(mkdtempSync(join(tmpdir(), "maple-reap-dry-")));
const origin = join(sb, "origin.git");
const repo = join(sb, "repo");
const other = join(sb, "other");
const wt = (n) => join(repo, ".worktrees", n);
const git = (args, cwd = repo) => {
  const r = sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
};
const reap = (...flags) => {
  const r = sh("bash", [posixish(join(HERE, "maple-reap.sh")), ...flags], { cwd: repo });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
};
/** Everything a read-only run must leave untouched. */
const snapshot = () => JSON.stringify({
  refs: git(["for-each-ref"]),
  worktrees: git(["worktree", "list", "--porcelain"]),
  admin: readdirSync(join(repo, ".git", "worktrees")).sort(),
  dirs: readdirSync(join(repo, ".worktrees")).sort(),
  config: readFileSync(join(repo, ".git", "config"), "utf8"),
  head: git(["rev-parse", "HEAD"]),
});
const branchNames = () => git(["branch", "--format=%(refname:short)"]).split("\n");

try {
  sh("git", ["init", "-q", "--bare", "-b", "main", origin]);
  sh("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
  git(["remote", "add", "origin", origin]);
  git(["push", "-q", "origin", "main"]);

  // main history: c1 (pi/parent), c2 (pi/child), c3 (tip). All pushed, so all merged into origin/main.
  git(["commit", "-q", "--allow-empty", "-m", "c1"]);
  git(["branch", "pi/parent"]);
  git(["branch", "pi/dirty"]);
  git(["commit", "-q", "--allow-empty", "-m", "c2"]);
  git(["branch", "pi/child"]);
  git(["commit", "-q", "--allow-empty", "-m", "c3"]);
  git(["push", "-q", "origin", "main"]);
  git(["branch", "agent/done", "main~1"]);

  git(["checkout", "-q", "-b", "pi/wip"]);
  git(["commit", "-q", "--allow-empty", "-m", "unlanded pi work"]);
  git(["checkout", "-q", "--detach"]);

  git(["worktree", "add", "-q", wt("done"), "agent/done"]);
  git(["worktree", "add", "-q", wt("pi-parent"), "pi/parent"]);
  git(["worktree", "add", "-q", wt("pi-child"), "pi/child"]);
  git(["worktree", "add", "-q", wt("pi-dirty"), "pi/dirty"]);
  writeFileSync(join(wt("pi-dirty"), "uncommitted.txt"), "wip\n");
  git(["worktree", "add", "-q", wt("pi-wip"), "pi/wip"]);
  // A stale admin entry: directory gone, `git worktree prune` would delete .git/worktrees/gone.
  git(["worktree", "add", "-q", "--detach", wt("gone"), "main"]);
  rmSync(wt("gone"), { recursive: true, force: true });

  // origin moves ahead of the local origin/main ref (a fetch would update it).
  sh("git", ["clone", "-q", origin, other]);
  git(["commit", "-q", "--allow-empty", "-m", "c4 from elsewhere"], other);
  git(["push", "-q", "origin", "main"], other);
  const remoteRefBefore = git(["rev-parse", "origin/main"]);

  console.log("== --dry-run (read-only)");
  for (const flags of [["--dry-run"], ["--dry-run", "--include-pi"], ["--dry-run", "--force"]]) {
    const before = snapshot();
    const d = reap(...flags);
    const label = flags.join(" ");
    check(`${label}: exits 0`, d.status === 0, d.status === 0 ? "" : d.out.slice(-500));
    check(`${label}: nothing changed (refs, worktrees, admin dirs, config, HEAD)`, snapshot() === before);
    check(`${label}: origin/main not fetched`, git(["rev-parse", "origin/main"]) === remoteRefBefore);
    check(`${label}: stale admin entry still there`, existsSync(join(repo, ".git", "worktrees", "gone")));
    check(`${label}: reports what prune would drop`, /would prune/.test(d.out) && /gone/.test(d.out), d.out.slice(-300));
    check(`${label}: reports what it would remove`, /\[dry\].*maple_remove_worktree.*done/.test(d.out));
  }
  const dryPi = reap("--dry-run", "--include-pi").out;
  check("--dry-run --include-pi lists pi removals", /\[dry\].*pi-child/.test(dryPi) && /\[dry\].*pi-parent/.test(dryPi));
  check("--dry-run without the flag does not list pi removals", !/\[dry\].*pi-(child|parent)/.test(reap("--dry-run").out));

  console.log("== real run, default (pi/* stays)");
  const r1 = reap();
  check("default run exits 0", r1.status === 0, r1.status === 0 ? "" : r1.out.slice(-500));
  check("merged agent worktree reaped", !existsSync(wt("done")));
  check("stale admin entry pruned by the real run", !existsSync(join(repo, ".git", "worktrees", "gone")));
  check("pi worktrees untouched without the flag", ["pi-parent", "pi-child", "pi-dirty", "pi-wip"].every((n) => existsSync(wt(n))));
  check("pi branches untouched without the flag", ["pi/parent", "pi/child", "pi/dirty", "pi/wip"].every((b) => branchNames().includes(b)));

  console.log("== real run, --include-pi");
  const r2 = reap("--include-pi");
  check("--include-pi exits 0", r2.status === 0, r2.status === 0 ? "" : r2.out.slice(-500));
  check("merged pi worktrees reaped", !existsSync(wt("pi-child")) && !existsSync(wt("pi-parent")));
  check("merged pi branches deleted", !branchNames().includes("pi/child") && !branchNames().includes("pi/parent"));
  const iChild = r2.out.indexOf("pi/child");
  const iParent = r2.out.indexOf("pi/parent");
  check("children removed before parents", iChild >= 0 && iParent >= 0 && iChild < iParent, `child@${iChild} parent@${iParent}`);
  check("dirty pi worktree kept", existsSync(join(wt("pi-dirty"), "uncommitted.txt")) && branchNames().includes("pi/dirty"));
  check("unmerged pi worktree + branch kept", existsSync(wt("pi-wip")) && branchNames().includes("pi/wip"));
} finally {
  sh("git", ["worktree", "prune"], { cwd: repo });
  rmSync(sb, { recursive: true, force: true });
}

if (failed) {
  console.log(`\nreap-dryrun: ${failed} assertion(s) FAILED.`);
  process.exit(1);
}
console.log("\nreap-dryrun: all assertions passed.");
