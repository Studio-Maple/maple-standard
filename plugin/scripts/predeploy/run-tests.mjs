#!/usr/bin/env node
/**
 * run-tests.mjs — runs every *.test.mjs in this directory sequentially
 * (plain node scripts, exit non-zero on failure — same style as loops/).
 * Run: node plugin/scripts/predeploy/run-tests.mjs
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(fileURLToPath(import.meta.url), "..");
let failed = 0;
for (const f of readdirSync(HERE).filter((x) => x.endsWith(".test.mjs")).sort()) {
  console.log(`\n=== ${f} ===`);
  if (spawnSync(process.execPath, [join(HERE, f)], { stdio: "inherit" }).status !== 0) failed++;
}
if (failed) { console.error(`\n${failed} predeploy test file(s) failed`); process.exit(1); }
console.log("\nall predeploy tests passed");
