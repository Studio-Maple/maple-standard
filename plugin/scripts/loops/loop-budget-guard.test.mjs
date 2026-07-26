#!/usr/bin/env node
/**
 * loop-budget-guard.test.mjs — standalone test for
 * plugin/hooks/loop-budget-guard.mjs (MJ-8). Same conventions as
 * budget.test.mjs: no framework, spawns the hook as a real subprocess
 * (it's a stdin-JSON-in / exit-code-out CLI, same as any other Claude Code
 * hook) feeding a payload against a throwaway `root`, and asserts the exit
 * code — 0 = allow, 2 = block.
 *   node plugin/scripts/loops/loop-budget-guard.test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, "..", "..", "hooks", "loop-budget-guard.mjs");

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

function writeCycle(root, cycle) {
  const dir = join(root, ".loop-state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "current-cycle.json"), JSON.stringify(cycle, null, 2) + "\n", "utf8");
}

function runGuard(root) {
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: root, tool_name: "Bash" }),
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
      turnLimit: 100,
      minutesLimit: 20,
      deadlineMs: Date.now() + 20 * 60000,
      toolCalls: 0,
    });
    const r = runGuard(root);
    if (r.status === 0) pass("within budget (fresh, low count) -> allow", `exit=${r.status}`);
    else fail("within budget (fresh, low count) -> allow", `exit=${r.status} stderr=${r.stderr}`);
  });
}

function testOverTurnBudgetBlocks() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "burn-backlog",
      startedAt: new Date().toISOString(),
      turnLimit: 1,
      minutesLimit: null,
      deadlineMs: null,
      toolCalls: 1, // already AT the cap — this call's bump pushes it over
    });
    const r = runGuard(root);
    if (r.status === 2 && /turn budget exceeded/.test(r.stderr)) {
      pass("over turn budget -> block", `exit=${r.status}, stderr mentions turn budget`);
    } else {
      fail("over turn budget -> block", `exit=${r.status} stderr=${r.stderr}`);
    }
  });
}

function testOverTimeBudgetBlocks() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "sweep-quality",
      startedAt: new Date(Date.now() - 30 * 60000).toISOString(),
      turnLimit: null,
      minutesLimit: 20,
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

function testAbandonedCycleFileSelfHeals() {
  withTempRoot((root) => {
    writeCycle(root, {
      loop: "detect-drift",
      startedAt: new Date(Date.now() - 7 * 60 * 60000).toISOString(), // 7h ago > 6h stale threshold
      turnLimit: 1,
      minutesLimit: 1,
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

function main() {
  testNoFileAllows();
  testWithinBudgetAllows();
  testOverTurnBudgetBlocks();
  testOverTimeBudgetBlocks();
  testAbandonedCycleFileSelfHeals();
  testCorruptCycleFileFailsOpen();

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} assertions passed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
