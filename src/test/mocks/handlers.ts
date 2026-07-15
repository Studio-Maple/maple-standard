import { http, HttpResponse } from "msw";

/**
 * Default MSW handlers, shared across tests. Add project-specific handlers
 * here (or per-test via `server.use(...)`) as your Supabase/API surface
 * grows. Kept empty-but-real so `pnpm test` demonstrates a working MSW setup
 * without inventing fake domain endpoints.
 */
export const handlers = [
  http.get("https://test.supabase.co/rest/v1/*", () => {
    return HttpResponse.json([]);
  }),
];
