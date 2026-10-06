#!/usr/bin/env node
/**
 * run-tests.mjs — runs every *.test.mjs in this directory (incl. hook.test.mjs, the dispatcher-level
 * dep-version-guard + install-guard test; plain node scripts, exit non-zero on failure — same style as jev/ and predeploy/).
 * Run: node plugin/scripts/deps/run-tests.mjs
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(fileURLToPath(import.meta.url), "..");
const files = [
  ...readdirSync(HERE).filter((x) => x.endsWith(".test.mjs")).sort().map((f) => join(HERE, f)),
];
let failed = 0;
for (const f of files) {
  console.log(`\n=== ${f.split(/[\\/]/).slice(-2).join("/")} ===`);
  if (spawnSync(process.execPath, [f], { stdio: "inherit" }).status !== 0) failed++;
}
if (failed) { console.error(`\n${failed} deps test file(s) failed`); process.exit(1); }
console.log("\nall deps tests passed");
