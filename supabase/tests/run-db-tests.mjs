#!/usr/bin/env node
/**
 * run-db-tests.mjs — runner for the Supabase RLS/trigger test suite.
 *
 * "Real boundaries in tests": RLS / auth / triggers are tested against a
 * LIVE local Supabase stack (Docker), never mocked — mocks only at unit
 * edges (that's what MSW in src/test/ is for). Ported pattern from
 * a production deployment of this harness.
 *
 * Runs every `*.test.mjs` file in this directory sequentially. Each test
 * file is a plain Node script that exits non-zero on failure. FAILS LOUDLY
 * (non-zero exit) if the local stack is unreachable — it never silently
 * skips; the tier scripts (scripts/ci-local.*) own the "skip if no Docker"
 * decision via SKIP_LIVE_GATE.
 *
 * Run: pnpm test:supabase   (stack must be up: pnpm supabase:start)
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
  console.log("No *.test.mjs files in supabase/tests/ — nothing to run.");
  process.exit(0);
}

let failed = 0;
for (const f of testFiles) {
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [join(HERE, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}

if (failed > 0) {
  console.error(`\n${failed}/${testFiles.length} RLS test file(s) FAILED.`);
  process.exit(1);
}
console.log(`\nAll ${testFiles.length} RLS test file(s) passed.`);
