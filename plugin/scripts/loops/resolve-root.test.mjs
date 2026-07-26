#!/usr/bin/env node
/**
 * resolve-root.test.mjs — standalone test for resolve-root.mjs (re-review
 * M4: writer/reader root agreement). See loop-budget-guard.test.mjs's
 * testWriterAndReaderAgreeAcrossAWorktree for the end-to-end (budget.mjs +
 * the guard) version of this same scenario; this file tests the shared
 * resolver in isolation.
 *   node plugin/scripts/loops/resolve-root.test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLoopRoot } from "./resolve-root.mjs";

const results = [];
function pass(name, detail) {
  results.push({ name, passed: true });
  console.log(`  PASS  ${name} — ${detail}`);
}
function fail(name, detail) {
  results.push({ name, passed: false });
  console.log(`  FAIL  ${name} — ${detail}`);
}

function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepoWithWorktree() {
  const tmp = mkdtempSync(join(tmpdir(), "resolve-root-test-"));
  const mainRepo = join(tmp, "main");
  mkdirSync(mainRepo, { recursive: true });
  git(["init", "-q"], mainRepo);
  git(["config", "user.email", "test@example.com"], mainRepo);
  git(["config", "user.name", "Test"], mainRepo);
  writeFileSync(join(mainRepo, "README.md"), "root\n", "utf8");
  git(["add", "README.md"], mainRepo);
  git(["commit", "-q", "-m", "init"], mainRepo);
  const worktreeDir = join(tmp, "wt");
  const r = git(["worktree", "add", "-q", "-b", "agent/test", worktreeDir], mainRepo);
  return { tmp, mainRepo, worktreeDir, ok: r.status === 0, err: r.stderr };
}

// Case 1: CLAUDE_PROJECT_DIR unset, an explicit cwd given (the worktree) ->
// resolves to the worktree itself, not some other guess.
function testExplicitCwdInsideWorktreeClaudeProjectDirUnset() {
  const { tmp, worktreeDir, ok, err } = makeRepoWithWorktree();
  try {
    if (!ok) return fail("explicit cwd inside worktree, CLAUDE_PROJECT_DIR unset", `setup failed: ${err}`);
    const savedEnv = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    try {
      const resolved = resolveLoopRoot(worktreeDir);
      // git prints a possibly different (e.g. case/symlink-normalized) but
      // equivalent absolute path — compare via a second git call for the
      // ground truth rather than string-comparing to worktreeDir directly.
      const truth = git(["-C", worktreeDir, "rev-parse", "--show-toplevel"], worktreeDir).stdout.trim();
      if (resolved === truth) pass("explicit cwd inside worktree, CLAUDE_PROJECT_DIR unset", `resolved=${resolved}`);
      else fail("explicit cwd inside worktree, CLAUDE_PROJECT_DIR unset", `resolved=${resolved} truth=${truth}`);
    } finally {
      if (savedEnv !== undefined) process.env.CLAUDE_PROJECT_DIR = savedEnv;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Case 2: CLAUDE_PROJECT_DIR SET AND DIFFERENT (points at the main
// checkout), explicit cwd is the worktree — the exact reproduced mismatch.
// The explicit cwd must win; CLAUDE_PROJECT_DIR must NOT leak in.
function testClaudeProjectDirSetAndDifferentExplicitCwdWins() {
  const { tmp, mainRepo, worktreeDir, ok, err } = makeRepoWithWorktree();
  try {
    if (!ok) return fail("CLAUDE_PROJECT_DIR set-and-different, explicit cwd wins", `setup failed: ${err}`);
    const savedEnv = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = mainRepo;
    try {
      const resolved = resolveLoopRoot(worktreeDir);
      const truthWorktree = git(["-C", worktreeDir, "rev-parse", "--show-toplevel"], worktreeDir).stdout.trim();
      const truthMain = git(["-C", mainRepo, "rev-parse", "--show-toplevel"], mainRepo).stdout.trim();
      if (resolved === truthWorktree && resolved !== truthMain) {
        pass("CLAUDE_PROJECT_DIR set-and-different, explicit cwd wins", `resolved=${resolved}, main=${truthMain}`);
      } else {
        fail("CLAUDE_PROJECT_DIR set-and-different, explicit cwd wins", `resolved=${resolved} truthWorktree=${truthWorktree} truthMain=${truthMain}`);
      }
    } finally {
      if (savedEnv === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = savedEnv;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Case 3: no explicit cwd, CLAUDE_PROJECT_DIR unset, process cwd itself is
// inside the worktree (the "shell cd'd into a worktree" scenario) ->
// resolves to the worktree via process.cwd() fallback.
function testNoArgsClaudeProjectDirUnsetProcessCwdInsideWorktree() {
  const { tmp, worktreeDir, ok, err } = makeRepoWithWorktree();
  try {
    if (!ok) return fail("no args, CLAUDE_PROJECT_DIR unset, cwd inside worktree", `setup failed: ${err}`);
    const savedEnv = process.env.CLAUDE_PROJECT_DIR;
    const savedCwd = process.cwd();
    delete process.env.CLAUDE_PROJECT_DIR;
    process.chdir(worktreeDir);
    try {
      const resolved = resolveLoopRoot();
      const truth = git(["-C", worktreeDir, "rev-parse", "--show-toplevel"], worktreeDir).stdout.trim();
      if (resolved === truth) pass("no args, CLAUDE_PROJECT_DIR unset, cwd inside worktree", `resolved=${resolved}`);
      else fail("no args, CLAUDE_PROJECT_DIR unset, cwd inside worktree", `resolved=${resolved} truth=${truth}`);
    } finally {
      process.chdir(savedCwd);
      if (savedEnv !== undefined) process.env.CLAUDE_PROJECT_DIR = savedEnv;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Fallback: a plain (non-git) directory is returned unchanged, never throws.
function testNonGitDirectoryFallsBackUnchanged() {
  const tmp = mkdtempSync(join(tmpdir(), "resolve-root-nongit-test-"));
  try {
    const resolved = resolveLoopRoot(tmp);
    // On some platforms tmp paths resolve through a symlink (e.g. macOS
    // /tmp -> /private/tmp); accept either the literal path or its
    // symlink-resolved form as "unchanged, not some git-repo guess".
    if (resolved === tmp || resolved.endsWith(tmp.split(/[\\/]/).pop())) {
      pass("non-git directory falls back unchanged", `resolved=${resolved}`);
    } else {
      fail("non-git directory falls back unchanged", `resolved=${resolved} tmp=${tmp}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  testExplicitCwdInsideWorktreeClaudeProjectDirUnset();
  testClaudeProjectDirSetAndDifferentExplicitCwdWins();
  testNoArgsClaudeProjectDirUnsetProcessCwdInsideWorktree();
  testNonGitDirectoryFallsBackUnchanged();

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} assertions passed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
