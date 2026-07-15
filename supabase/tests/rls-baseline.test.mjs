#!/usr/bin/env node
/**
 * rls-baseline.test.mjs — example RLS test against the LIVE local stack.
 *
 * This is the template every project-specific RLS test copies: connect
 * with the ANON key only (the real client context — SQL Editor bypasses
 * RLS and proves nothing), attempt operations, assert the policy verdicts.
 *
 * The baseline assertions here are schema-independent so they pass on a
 * fresh clone with zero migrations:
 *   1. The stack is reachable (fail loudly, never silently skip).
 *   2. An anon client cannot read a nonexistent table (PostgREST 404/42P01,
 *      never a data leak).
 *
 * As you add tables, extend this file (or add siblings) with real
 * assertions per policy:
 *   - public-read tables: anon SELECT succeeds
 *   - owner-only tables: anon SELECT returns 0 rows / permission error
 *   - write paths: anon INSERT/UPDATE/DELETE rejected
 * For authenticated-context policies, mint a JWT with the local stack's
 * demo secret and run as a seeded test user.
 */
import { createClient } from "@supabase/supabase-js";

import { LOCAL_SUPABASE_URL, LOCAL_ANON_KEY } from "./local-defaults.mjs";

const supabase = createClient(LOCAL_SUPABASE_URL, LOCAL_ANON_KEY);

const results = [];
function pass(name, detail) {
  results.push({ name, passed: true });
  console.log(`  PASS  ${name} — ${detail}`);
}
function fail(name, detail) {
  results.push({ name, passed: false });
  console.log(`  FAIL  ${name} — ${detail}`);
}

// ── Reachability gate — fail loudly, never silently skip ────────────────
async function assertStackReachable() {
  try {
    const res = await fetch(`${LOCAL_SUPABASE_URL}/auth/v1/health`, {
      headers: { apikey: LOCAL_ANON_KEY },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`auth health returned ${res.status}`);
  } catch (err) {
    console.error(
      `FATAL: cannot reach Supabase at ${LOCAL_SUPABASE_URL}.\n` +
        `  Is the local stack up? \`pnpm supabase:start\` (Docker required).\n` +
        `  Underlying error: ${err instanceof Error ? err.message : String(err)}`
    );
    process.exitCode = 1;
    throw new Error("local Supabase stack unreachable — aborting this test file");
  }
}

async function main() {
  await assertStackReachable();
  pass("stack reachable", `auth health OK at ${LOCAL_SUPABASE_URL}`);

  // Anon probing an unknown table must get a clean PostgREST error, not data.
  const { data, error } = await supabase.from("definitely_not_a_real_table").select("*").limit(1);
  if (error && !data) {
    pass("unknown table probe", `rejected as expected (${error.code ?? error.message})`);
  } else {
    fail("unknown table probe", "expected an error, got data — investigate PostgREST config");
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} assertions passed.`);
  // exitCode (not process.exit): a forced exit aborts mid-teardown of
  // undici keep-alive handles and crashes libuv on Windows (async.c:76),
  // which the runner then counts as a file failure.
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("Unhandled test error:", err);
  process.exitCode = 1;
});
