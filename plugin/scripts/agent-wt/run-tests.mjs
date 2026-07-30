#!/usr/bin/env node
/**
 * run-tests.mjs — runner for the agent-wt worktree-lifecycle tests.
 * Mirrors plugin/scripts/loops/run-tests.mjs: runs every `*.test.mjs` file
 * in this directory sequentially, each a plain Node script that exits
 * non-zero on failure (the repo's standalone test style — no framework, no
 * new dep).
 *
 * Run: node plugin/scripts/agent-wt/run-tests.mjs
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(fileURLToPath(import.meta.url), "..");

const testFiles = readdirSync(HERE)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

if (testFiles.length === 0) {
  console.log("No *.test.mjs files in plugin/scripts/agent-wt/ — nothing to run.");
  process.exit(0);
}

let failed = 0;
for (const f of testFiles) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [join(HERE, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

if (failed > 0) {
  console.error(`\n${failed}/${testFiles.length} agent-wt test file(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${testFiles.length} agent-wt test file(s) passed.`);
