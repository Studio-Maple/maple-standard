"use client";

/**
 * Browser Supabase client — for use in Client Components.
 *
 * `services/` is the data layer: no React imports (dependency-cruiser
 * `services-no-react`), and every client factory call MUST carry the
 * `<Database>` generic (ESLint `local/require-database-generic`, #T-style
 * enforcement) so an untyped client can never silently turn the whole query
 * surface into `any`. Pairs with the `database.types.ts` freshness gate.
 */
import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/types/database.types";

let browserClient: ReturnType<typeof createBrowserClient<Database>> | undefined;

/**
 * Returns a singleton browser Supabase client. Safe to call from any Client
 * Component; the underlying client is memoized per page load.
 */
export function createClient() {
  if (browserClient) return browserClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. " +
        "Copy .env.example to .env.local and fill in your Supabase project values."
    );
  }

  browserClient = createBrowserClient<Database>(url, anonKey);
  return browserClient;
}
