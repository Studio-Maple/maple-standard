#!/usr/bin/env node
/**
 * check-types-fresh.mjs — fails if src/types/database.types.ts is stale vs
 * the local Supabase schema (the types-freshness guarantee).
 *
 * Regenerates types from the LOCAL stack (source of truth — migrations are
 * canonical) into a temp file and diffs against the committed file. Requires
 * the local Supabase stack to be up (`pnpm supabase:start`); fails open
 * (skips, exit 0) if it's not reachable, so this never blocks a machine
 * without Docker — the CI backstop is
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

function stackUp() {
  const probe = spawnSync("supabase", ["status", "-o", "env"], { cwd: ROOT, encoding: "utf8" });
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
    console.log("(skipped — local Supabase not up; CI's supabase-migrations.yml is the backstop)");
    process.exit(0);
  }

  const gen = spawnSync("supabase", ["gen", "types", "typescript", "--local"], {
    cwd: ROOT,
    encoding: "utf8",
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
