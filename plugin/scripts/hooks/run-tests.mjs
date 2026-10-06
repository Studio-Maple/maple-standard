#!/usr/bin/env node
/**
 * run-tests.mjs — runs every plugin hook test (D065): the fixture-driven guard contracts, the dispatcher
 * process contract, the wiring check and the config contract. Plain node scripts, exit non-zero on failure.
 * Run: node plugin/scripts/hooks/run-tests.mjs   (pnpm test:plugin-hooks)
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(HERE).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => join(HERE, f));
let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f.split(/[\\/]/).slice(-2).join("/")} ===`);
  if (spawnSync(process.execPath, [f], { stdio: "inherit" }).status !== 0) failed++;
}
if (failed) { console.error(`\n${failed} hooks test file(s) failed`); process.exit(1); }
console.log("\nall hooks tests passed");
