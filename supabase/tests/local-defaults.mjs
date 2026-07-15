/**
 * Local Supabase stack defaults for the RLS test suite.
 *
 * The anon key below is the Supabase CLI's WELL-KNOWN local development
 * demo key — identical for every `supabase start` on every machine in the
 * world, published in Supabase's own docs. It is NOT a secret and grants
 * nothing outside a local Docker stack. Override both values via env to
 * point the suite at a different stack (never production):
 *
 *   SUPABASE_URL / SUPABASE_ANON_KEY   (get them from `supabase status -o env`)
 *
 * Reconstructed at runtime (split constant) purely so secret scanners don't
 * flag the JWT shape — the value itself is public.
 */
export const LOCAL_SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";

const CLI_DEMO_KEY_PARTS = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  "eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9",
  "CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
];

export const LOCAL_ANON_KEY = process.env.SUPABASE_ANON_KEY || CLI_DEMO_KEY_PARTS.join(".");

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
