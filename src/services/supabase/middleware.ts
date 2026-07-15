import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { Database } from "@/types/database.types";

/**
 * Refreshes the Supabase auth session on every request. Wire this into
 * `middleware.ts` at the project root:
 *
 *   export { updateSession as middleware } from "@/services/supabase/middleware";
 *   export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
 *
 * Not wired by default in this template — most projects gate this behind
 * their own auth requirements. Kept here (services/, no default export) so
 * it's a one-line opt-in rather than boilerplate every project re-writes.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return response;

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Refreshes the session if expired — required for Server Components, which
  // cannot write cookies themselves.
  await supabase.auth.getUser();

  return response;
}
