#!/usr/bin/env node
/**
 * check-types-fresh.mjs — fails if src/types/database.types.ts is stale vs
 * the local Supabase schema (the types-freshness guarantee).
 *
 * Regenerates types from the LOCAL stack (source of truth — migrations are
 * canonical) into a temp file and diffs against the committed file. Requires
 * the local Supabase stack to be up (`pnpm supabase:start`); fails open
 * (skips, exit 0) if it's not reachable, so this never blocks a machine
 * without Docker (the heavy tier sets MAPLE_REQUIRE_STACK=1 and fails instead) — the CI backstop is
 * .github/workflows/supabase-migrations.yml, which builds the DB fresh
 * from migrations every run.
 *
 * Run: node scripts/check-types-fresh.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const TYPES_PATH = join(ROOT, "src", "types", "database.types.ts");

// D071: the heavy tier runs against the isolated CI stack; its workdir (a copy of supabase/ under project_id <id>-ci) is
// exported as CI_SUPABASE_WORKDIR by ci-stack.mjs env, and every CLI call below is pointed at it - never at the dev stack.
const WORKDIR = process.env.CI_SUPABASE_WORKDIR;
// (spawned with a shell on Windows below, so the path is quoted there)
const WORKDIR_ARGS = WORKDIR ? ["--workdir", process.platform === "win32" ? `"${WORKDIR}"` : WORKDIR] : [];

function stackUp() {
  // pnpm exec: the project's own CLI, not whatever global one is on PATH (shell: pnpm is a .cmd shim on Windows)
  const probe = spawnSync("pnpm", ["exec", "supabase", "status", "-o", "env", ...WORKDIR_ARGS], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32" });
  return probe.status === 0;
}

function main() {
  // Migration-less template clone: the committed placeholder types
  // intentionally differ from generated-empty-schema output. The gate arms
  // itself the moment the first real migration lands.
  const migrationsDir = join(ROOT, "supabase", "migrations");
  let hasMigrations = false;
  try {
    hasMigrations = readdirSync(migrationsDir).some((f) => f.endsWith(".sql"));
  } catch {
    /* no migrations dir at all */
  }
  if (!hasMigrations) {
    console.log("(skipped — no migrations yet; placeholder types are fine until the first migration)");
    process.exit(0);
  }

  if (!stackUp()) {
    // The heavy tier requires the stack (MAPLE_REQUIRE_STACK=1): a freshness check that silently skips is no check.
    if (process.env.MAPLE_REQUIRE_STACK === "1") {
      console.error("types-freshness: the local Supabase stack is not up and this run requires it (heavy tier).");
      process.exit(1);
    }
    console.log("(skipped — local Supabase not up; CI's supabase-migrations.yml is the backstop)");
    process.exit(0);
  }

  const gen = spawnSync("pnpm", ["exec", "supabase", "gen", "types", "typescript", "--local", ...WORKDIR_ARGS], {
    cwd: ROOT,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (gen.status !== 0) {
    console.error("supabase gen types failed:\n" + gen.stderr);
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), "maple-types-"));
  const tmpFile = join(dir, "database.types.generated.ts");
  writeFileSync(tmpFile, gen.stdout, "utf8");

  const current = readFileSync(TYPES_PATH, "utf8");
  const fresh = gen.stdout;

  rmSync(dir, { recursive: true, force: true });

  if (current.trim() !== fresh.trim()) {
    console.error(
      "src/types/database.types.ts is STALE vs the local schema. Regenerate + commit:\n" +
        "  pnpm supabase:types\n"
    );
    process.exit(1);
  }
  console.log("database.types.ts matches the local schema.");
}

main();
