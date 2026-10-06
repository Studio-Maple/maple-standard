#!/usr/bin/env node
/**
 * run-integration.mjs - the heavy tier's "plugin integration suites" step (D066): every suite's
 * *.integration.test.* set (real Docker/network/scanners, minutes of real git/worktree work), in turn.
 * Fails if any suite fails, but always runs all of them so one report shows every red suite.
 * Run: node plugin/scripts/gate/run-integration.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
const SUITES = ["loops", "agent-wt", "jev", "predeploy", "deps", "prepush", "gate"];
let failed = 0;
for (const s of SUITES) {
  const runner = join(SCRIPTS, s, "run-tests.mjs");
  if (!existsSync(runner)) continue;
  console.log(`\n##### ${s} - integration set #####`);
  if (spawnSync(process.execPath, [runner, "--integration"], { stdio: "inherit" }).status !== 0) failed++;
}
if (failed) {
  console.error(`\n${failed} suite(s) had failing integration tests.`);
  process.exit(1);
}
console.log("\nall plugin integration suites passed");
