#!/usr/bin/env node
/**
 * run-tests.mjs — runs the pre-push tests (bash, hermetic: temp git repos, no network):
 *   prepush-lib.test.sh   range selection, fail-closed FULL rules, tree-bound stamp, slots
 *   install-hooks.test.sh real `git push`es from real worktrees: hooks fail closed
 *   landing-lock.test.sh  staleness fail-fast + per-branch landing lock, two real concurrent pushes
 *
 * Run: node plugin/scripts/prepush/run-tests.mjs
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(fileURLToPath(import.meta.url), "..");
let failed = 0;
for (const t of ["prepush-lib.test.sh", "install-hooks.test.sh", "landing-lock.test.sh"]) {
  console.log(`\n=== ${t} ===`);
  const r = spawnSync("bash", [join(HERE, t)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
process.exit(failed === 0 ? 0 : 1);
