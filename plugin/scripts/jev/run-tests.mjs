#!/usr/bin/env node
/**
 * run-tests.mjs — runner for the jev/* unit tests. Mirrors
 * plugin/scripts/agent-wt/run-tests.mjs: runs every `*.test.mjs` file in
 * this directory sequentially, each a plain Node script that exits
 * non-zero on failure (the repo's standalone test style — no framework).
 *
 * Run: node plugin/scripts/jev/run-tests.mjs
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(fileURLToPath(import.meta.url), "..");
const HOOKS_DIR = join(HERE, "..", "..", "hooks");
const AUDIT_DIR = join(HERE, "audit");

const testFiles = [
  ...readdirSync(HERE)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort()
    .map((f) => join(HERE, f)),
  // jev-validate-subagent.mjs lives in plugin/hooks/ (it's a hook, not a
  // library module) but is part of this same feature — run its test here
  // too rather than standing up a whole new plugin/hooks test runner for
  // one file.
  join(HOOKS_DIR, "jev-validate-subagent.test.mjs"),
  // The quality-gate audit engine (docs/decisions.md D051) lives one level
  // down in jev/audit/ — same "no framework, exit code is the verdict"
  // style, so it's swept in here rather than getting its own runner.
  ...readdirSync(AUDIT_DIR)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort()
    .map((f) => join(AUDIT_DIR, f)),
];

if (testFiles.length === 0) {
  console.log("No *.test.mjs files in plugin/scripts/jev/ — nothing to run.");
  process.exit(0);
}

let failed = 0;
for (const f of testFiles) {
  console.log(`\n=== ${f.split(/[\\/]/).slice(-2).join("/")} ===`);
  const r = spawnSync(process.execPath, [f], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

if (failed > 0) {
  console.error(`\n${failed}/${testFiles.length} jev test file(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${testFiles.length} jev test file(s) passed.`);
