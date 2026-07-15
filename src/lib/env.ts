import { z } from "zod";

/**
 * Schema for the PUBLIC (client-exposed) env surface. Only variables
 * prefixed `NEXT_PUBLIC_` belong here — anything else is server-only and
 * must never be imported from a Client Component.
 *
 * Deliberately lazy: `getPublicEnv()` throws only when called, not at
 * module load, so importing this file never breaks a build/prerender that
 * doesn't need real values yet (e.g. a fresh clone before Supabase/Sentry
 * are wired up).
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional(),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

/** Validate and return the public env. Throws a readable error on failure. */
export function getPublicEnv(): PublicEnv {
  const result = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN || undefined,
  });
  if (!result.success) {
    throw new Error(`Invalid/missing public env vars:\n${result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}\nCopy .env.example to .env.local and fill in your Supabase project values.`);
  }
  return result.data;
}
