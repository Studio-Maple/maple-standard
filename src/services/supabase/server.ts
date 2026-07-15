import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import type { Database } from "@/types/database.types";

/**
 * Server Supabase client — for use in Server Components, Route Handlers, and
 * Server Actions. Must be created PER REQUEST (cookies() is request-scoped),
 * unlike the memoized browser client.
 *
 * Every call site importing this module needs `<Database>` on the factory —
 * ESLint `local/require-database-generic` fails the build otherwise.
 */
export async function createClient() {
  const cookieStore = await cookies();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set. " +
        "Copy .env.example to .env.local and fill in your Supabase project values."
    );
  }

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // `setAll` is called from a Server Component sometimes — Next.js
          // ignores cookie writes there. Safe to swallow when middleware is
          // already refreshing the session (see services/supabase/middleware.ts).
        }
      },
    },
  });
}
