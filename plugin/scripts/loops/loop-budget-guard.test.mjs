#!/usr/bin/env node
/**
 * loop-budget-guard.test.mjs — standalone test for
 * plugin/hooks/loop-budget-guard.mjs (MJ-8, re-review B1/B2/M2/M4/m2/m3).
 * Same conventions as budget.test.mjs: no framework, spawns the hook as a
 * real subprocess (it's a stdin-JSON-in / exit-code-out CLI, same as any
 * other Claude Code hook) feeding a payload against a throwaway `root`, and
 * asserts the exit code — 0 = allow, 2 = block.
 *   node plugin/scripts/loops/loop-budget-guard.test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, "..", "..", "hooks", "loop-budget-guard.mjs");
const BUDGET = join(HERE, "budget.mjs");

const results = [];
function pass(name, detail) {
  results.push({ name, passed: true });
  console.log(`  PASS  ${name} — ${detail}`);
}
function fail(name, detail) {
  results.push({ name, passed: false });
  console.log(`  FAIL  ${name} — ${detail}`);
}

function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "loop-budget-guard-test-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function cycleFile(root) {
  return join(root, ".loop-state", "current-cycle.json");
}

function writeCycle(root, cycle) {
  const dir = join(root, ".loop-state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(cycleFile(root), JSON.stringify(cycle, null, 2) + "\n", "utf8");
}

function readCycle(root) {
  return JSON.parse(readFileSync(cycleFile(root), "utf8"));
}

function runGuard(root, extra = {}) {
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: root, tool_name: "Bash", ...extra }),
    encoding: "utf8",
  });
}

function testNoFileAllows() {
  withTempRoot((root) => {
    const r = runGuard(root);
    if (r.status === 0) pass("no cycle file -> allow", `exit=${r.status}`);
    else fail("no cycle file -> allow", `exit=${r.status} stderr=${r.stderr}`);
  });
}

function testWithinBudgetAllows() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "burn-backlog",
      startedAt: new Date().toISOString(),
      turnLimit: 40,
      minutesLimit: 20,
      toolCallLimit: 400,
      deadlineMs: Date.now() + 20 * 60000,
      toolCalls: 0,
    });
    const r = runGuard(root);
    if (r.status === 0) pass("within budget (fresh, low count) -> allow", `exit=${r.status}`);
    else fail("within budget (fresh, low count) -> allow", `exit=${r.status} stderr=${r.stderr}`);
  });
}

// B2: the guard must enforce toolCallLimit, and must NOT block just because
// turnLimit (a completely different unit — loop iterations, not tool
// calls) is small. Reproduces the original bug directly: turnLimit=1 (a
// loop-iteration cap that would previously have blocked this hook at tool
// call #2) with a generous toolCallLimit must still ALLOW.
function testTurnLimitIsNeverEnforcedByTheGuard() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "burn-backlog",
      startedAt: new Date().toISOString(),
      turnLimit: 1, // tiny loop-iteration cap — must be irrelevant to this hook
      minutesLimit: null,
      toolCallLimit: 400,
      deadlineMs: null,
      toolCalls: 39, // well past turnLimit, well under toolCallLimit
    });
    const r = runGuard(root);
    if (r.status === 0) pass("small turnLimit alone never blocks (B2)", `exit=${r.status}`);
    else fail("small turnLimit alone never blocks (B2)", `exit=${r.status} stderr=${r.stderr}`);
  });
}

function testOverToolCallBudgetBlocksOnce() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "burn-backlog",
      startedAt: new Date().toISOString(),
      turnLimit: 40,
      minutesLimit: null,
      toolCallLimit: 1,
      deadlineMs: null,
      toolCalls: 1, // already AT the cap — this call's bump pushes it over
    });
    const r = runGuard(root);
    const cycleAfter = readCycle(root);
    if (r.status === 2 && /tool-call budget exceeded/.test(r.stderr) && cycleAfter.blocked === true) {
      pass("over tool-call budget -> block once, persists blocked:true", `exit=${r.status}, stderr mentions tool-call budget`);
    } else {
      fail("over tool-call budget -> block once, persists blocked:true", `exit=${r.status} stderr=${r.stderr} cycle=${JSON.stringify(cycleAfter)}`);
    }
  });
}

function testOverTimeBudgetBlocks() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "sweep-quality",
      startedAt: new Date(Date.now() - 30 * 60000).toISOString(),
      turnLimit: 40,
      minutesLimit: 20,
      toolCallLimit: 400,
      deadlineMs: Date.now() - 60000, // deadline already passed
      toolCalls: 0,
    });
    const r = runGuard(root);
    if (r.status === 2 && /wall-clock budget exceeded/.test(r.stderr)) {
      pass("over wall-clock budget -> block", `exit=${r.status}, stderr mentions wall-clock`);
    } else {
      fail("over wall-clock budget -> block", `exit=${r.status} stderr=${r.stderr}`);
    }
  });
}

// B1: the ONE-SHOT contract. First violation blocks; every subsequent call
// (simulating the agent's own revert/log/clear tool calls) allows — this is
// the exact deadlock the re-review reproduced (Bash=2 Write=2 Edit=2
// TodoWrite=2 forever, only escaped by the 6h staleness window).
function testOneShotThenAllowsRepeatedly() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "burn-backlog",
      startedAt: new Date().toISOString(),
      turnLimit: 40,
      minutesLimit: null,
      toolCallLimit: 1,
      deadlineMs: null,
      toolCalls: 1,
    });
    const first = runGuard(root);
    const second = runGuard(root, { tool_name: "Write" });
    const third = runGuard(root, { tool_name: "Edit" });
    const fourth = runGuard(root, { tool_name: "TodoWrite" });
    if (first.status === 2 && second.status === 0 && third.status === 0 && fourth.status === 0) {
      pass("one-shot: 1st call blocks, every call after allows", `exits=[${first.status},${second.status},${third.status},${fourth.status}]`);
    } else {
      fail(
        "one-shot: 1st call blocks, every call after allows",
        `exits=[${first.status},${second.status},${third.status},${fourth.status}] stderr1=${first.stderr}`
      );
    }
  });
}

// B1: blocked flag must survive a reread (fresh process each call, same as
// production — the hook is a new node process per tool call).
function testBlockedFlagSurvivesAReread() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "burn-backlog",
      startedAt: new Date().toISOString(),
      turnLimit: 40,
      toolCallLimit: 1,
      deadlineMs: null,
      toolCalls: 1,
    });
    runGuard(root); // triggers the one block, writes blocked:true
    const persisted = readCycle(root);
    const second = runGuard(root); // brand-new process, must reread from disk
    if (persisted.blocked === true && second.status === 0) {
      pass("blocked flag survives a reread", `persisted.blocked=${persisted.blocked}, second exit=${second.status}`);
    } else {
      fail("blocked flag survives a reread", `persisted=${JSON.stringify(persisted)} second exit=${second.status}`);
    }
  });
}

// A fresh cycle (budget.mjs start's own shape) never carries `blocked` —
// confirms a new cycle always starts unblocked.
function testFreshStartedCycleHasNoBlockedFlag() {
  withTempRoot((root) => {
    const r = spawnSync(process.execPath, [BUDGET, "start", "--loop", "burn-backlog", "--tool-call-limit", "400", "--root", root], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      fail("fresh budget.mjs start cycle has no blocked flag", `budget.mjs start failed: ${r.stderr}`);
      return;
    }
    const cycle = readCycle(root);
    if (!("blocked" in cycle)) {
      pass("fresh budget.mjs start cycle has no blocked flag", `cycle keys: ${Object.keys(cycle).join(",")}`);
    } else {
      fail("fresh budget.mjs start cycle has no blocked flag", `cycle=${JSON.stringify(cycle)}`);
    }
  });
}

function testAbandonedCycleFileSelfHeals() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "detect-drift",
      startedAt: new Date(Date.now() - 7 * 60 * 60000).toISOString(), // 7h ago > 6h stale threshold
      turnLimit: 40,
      minutesLimit: 1,
      toolCallLimit: 1,
      deadlineMs: Date.now() - 6 * 60 * 60000, // long past deadline too
      toolCalls: 99,
    });
    const r = runGuard(root);
    if (r.status === 0) pass("abandoned (>6h old) cycle file -> self-heals to allow", `exit=${r.status}`);
    else fail("abandoned (>6h old) cycle file -> self-heals to allow", `exit=${r.status} stderr=${r.stderr}`);
  });
}

function testCorruptCycleFileFailsOpen() {
  withTempRoot((root) => {
    const dir = join(root, ".loop-state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "current-cycle.json"), "{ not valid json", "utf8");
    const r = runGuard(root);
    if (r.status === 0) pass("corrupt cycle file -> fails open (allow)", `exit=${r.status}`);
    else fail("corrupt cycle file -> fails open (allow)", `exit=${r.status} stderr=${r.stderr}`);
  });
}

// M2: startedAt shapes — absent, unparseable, and numeric epoch.
function testStartedAtAbsentFallsBackToMtimeNotPermanentBlock() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "burn-backlog",
      // startedAt intentionally omitted
      turnLimit: 40,
      toolCallLimit: 1,
      deadlineMs: null,
      toolCalls: 1,
    });
    // The cycle file was just written -> mtime is "now" -> not stale -> the
    // guard still evaluates the budget normally (and blocks, since
    // toolCallLimit=1/toolCalls=1 is over). The point: it does NOT skip the
    // staleness check forever (the old NaN bug) or crash.
    const r = runGuard(root);
    if (r.status === 2 && /tool-call budget exceeded/.test(r.stderr)) {
      pass("absent startedAt -> falls back to file mtime, still evaluates normally", `exit=${r.status}`);
    } else {
      fail("absent startedAt -> falls back to file mtime, still evaluates normally", `exit=${r.status} stderr=${r.stderr}`);
    }
  });
}

function testStartedAtGarbageStringDoesNotPermanentlyBlock() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "burn-backlog",
      startedAt: "not-a-date",
      turnLimit: 40,
      toolCallLimit: 1,
      deadlineMs: null,
      toolCalls: 1,
    });
    const r = runGuard(root);
    // Same expectation as the absent case: falls back to mtime (fresh ->
    // not stale), evaluates the real budget, blocks because it's over.
    if (r.status === 2 && /tool-call budget exceeded/.test(r.stderr)) {
      pass('garbage startedAt ("not-a-date") -> falls back to mtime, evaluates normally', `exit=${r.status}`);
    } else {
      fail('garbage startedAt ("not-a-date") -> falls back to mtime, evaluates normally', `exit=${r.status} stderr=${r.stderr}`);
    }
  });
}

function testStartedAtNumericEpochAccepted() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "burn-backlog",
      startedAt: Date.now() - 5 * 60000, // numeric epoch ms, 5 minutes ago — well under STALE_MS
      turnLimit: 40,
      minutesLimit: null,
      toolCallLimit: 400,
      deadlineMs: null,
      toolCalls: 0,
    });
    const r = runGuard(root);
    if (r.status === 0) pass("numeric-epoch startedAt accepted, not stale -> normal allow", `exit=${r.status}`);
    else fail("numeric-epoch startedAt accepted, not stale -> normal allow", `exit=${r.status} stderr=${r.stderr}`);
  });
}

function testStartedAtNumericEpochStaleStillSelfHeals() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "burn-backlog",
      startedAt: Date.now() - 7 * 60 * 60000, // numeric epoch, 7h ago -> stale
      turnLimit: 40,
      toolCallLimit: 1,
      deadlineMs: null,
      toolCalls: 99,
    });
    const r = runGuard(root);
    if (r.status === 0) pass("numeric-epoch startedAt, stale -> self-heals to allow", `exit=${r.status}`);
    else fail("numeric-epoch startedAt, stale -> self-heals to allow", `exit=${r.status} stderr=${r.stderr}`);
  });
}

// m3: Number() coercion — a string-typed toolCalls (hand-edited/older file
// shape) must not string-concatenate ("3" + 1 -> "31").
function testStringToolCallsCoercedNumerically() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "burn-backlog",
      startedAt: new Date().toISOString(),
      turnLimit: 40,
      toolCallLimit: 5,
      deadlineMs: null,
      toolCalls: "3", // string, not number
    });
    const r = runGuard(root);
    const cycleAfter = readCycle(root);
    if (r.status === 0 && cycleAfter.toolCalls === 4) {
      pass('string toolCalls "3" coerced to 4, not "31"', `exit=${r.status}, toolCalls=${cycleAfter.toolCalls}`);
    } else {
      fail('string toolCalls "3" coerced to 4, not "31"', `exit=${r.status} toolCalls=${JSON.stringify(cycleAfter.toolCalls)}`);
    }
  });
}

// m2: no limits configured at all -> the guard must not write to the cycle
// file (nothing to bump, nothing to gate).
function testNoLimitsConfiguredSkipsWriteEntirely() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "burn-backlog",
      startedAt: new Date().toISOString(),
      turnLimit: null,
      minutesLimit: null,
      toolCallLimit: null,
      deadlineMs: null,
      toolCalls: 0,
    });
    const before = readFileSync(cycleFile(root), "utf8");
    const r = runGuard(root);
    const after = readFileSync(cycleFile(root), "utf8");
    if (r.status === 0 && before === after) {
      pass("no limits configured -> file untouched (no write)", `exit=${r.status}`);
    } else {
      fail("no limits configured -> file untouched (no write)", `exit=${r.status} changed=${before !== after}`);
    }
  });
}

// M4: root agreement — the writer (budget.mjs start, via a real git
// worktree) and the reader (this guard, given only a payload.cwd inside
// that worktree) must resolve to the SAME cycle file even when
// CLAUDE_PROJECT_DIR points at the MAIN checkout, reproducing the exact
// scenario the re-review found: a standing session cd'd into a worktree
// while CLAUDE_PROJECT_DIR still names the main checkout.
function testWriterAndReaderAgreeAcrossAWorktree() {
  const tmp = mkdtempSync(join(tmpdir(), "loop-root-agreement-test-"));
  try {
    const mainRepo = join(tmp, "main");
    mkdirSync(mainRepo, { recursive: true });
    const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
    git(["init", "-q"], mainRepo);
    git(["config", "user.email", "test@example.com"], mainRepo);
    git(["config", "user.name", "Test"], mainRepo);
    writeFileSync(join(mainRepo, "README.md"), "root\n", "utf8");
    git(["add", "README.md"], mainRepo);
    git(["commit", "-q", "-m", "init"], mainRepo);

    const worktreeDir = join(tmp, "wt");
    const wtResult = git(["worktree", "add", "-q", "-b", "agent/test", worktreeDir], mainRepo);
    if (wtResult.status !== 0) {
      fail("writer/reader agree across a worktree (M4)", `git worktree add failed: ${wtResult.stderr}`);
      return;
    }

    // Writer: budget.mjs start with NO --root, CLAUDE_PROJECT_DIR pointing
    // at the MAIN checkout, but its own cwd inside the WORKTREE — the exact
    // reproduced mismatch. resolveLoopRoot must git-toplevel-ize the
    // worktree, not fall through to CLAUDE_PROJECT_DIR.
    const startResult = spawnSync(process.execPath, [BUDGET, "start", "--loop", "burn-backlog", "--tool-call-limit", "1"], {
      cwd: worktreeDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: mainRepo },
      encoding: "utf8",
    });
    if (startResult.status !== 0) {
      fail("writer/reader agree across a worktree (M4)", `budget.mjs start failed: ${startResult.stderr}`);
      return;
    }

    const wroteIntoWorktree = existsSync(join(worktreeDir, ".loop-state", "current-cycle.json"));
    const wroteIntoMain = existsSync(join(mainRepo, ".loop-state", "current-cycle.json"));

    // Reader: the guard, given payload.cwd = the worktree (same as Claude
    // Code would report for a session sitting in that worktree), same
    // CLAUDE_PROJECT_DIR pointing elsewhere. toolCallLimit=1 with a fresh
    // toolCalls:0 -> this first call bumps to 1, AT the cap, not yet over
    // -> allow. The proof is that it can see the file at all.
    const guardResult = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ cwd: worktreeDir, tool_name: "Bash" }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: mainRepo },
      encoding: "utf8",
    });

    if (wroteIntoWorktree && !wroteIntoMain && guardResult.status === 0) {
      pass("writer/reader agree across a worktree (M4)", "budget.mjs wrote into the worktree, not main; guard read it successfully");
    } else {
      fail(
        "writer/reader agree across a worktree (M4)",
        `wroteIntoWorktree=${wroteIntoWorktree} wroteIntoMain=${wroteIntoMain} guardExit=${guardResult.status} guardStderr=${guardResult.stderr}`
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function main() {
  testNoFileAllows();
  testWithinBudgetAllows();
  testTurnLimitIsNeverEnforcedByTheGuard();
  testOverToolCallBudgetBlocksOnce();
  testOverTimeBudgetBlocks();
  testOneShotThenAllowsRepeatedly();
  testBlockedFlagSurvivesAReread();
  testFreshStartedCycleHasNoBlockedFlag();
  testAbandonedCycleFileSelfHeals();
  testCorruptCycleFileFailsOpen();
  testStartedAtAbsentFallsBackToMtimeNotPermanentBlock();
  testStartedAtGarbageStringDoesNotPermanentlyBlock();
  testStartedAtNumericEpochAccepted();
  testStartedAtNumericEpochStaleStillSelfHeals();
  testStringToolCallsCoercedNumerically();
  testNoLimitsConfiguredSkipsWriteEntirely();
  testWriterAndReaderAgreeAcrossAWorktree();

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} assertions passed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
