import "@testing-library/jest-dom/vitest";

import { afterAll, afterEach, beforeAll } from "vitest";

import { server } from "./mocks/server";

// MSW — intercepts network calls at the fetch layer so unit/component tests
// never hit a real Supabase project or external API. Real-boundary behavior
// (RLS, auth, migrations) belongs in supabase/tests/ against a live local
// Supabase instance instead — mocks only at the unit edge.
beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// jsdom does not implement matchMedia — provide a minimal, non-matching
// stub so components using media-query hooks render in tests. Individual
// tests override it (see useMediaQuery.test.ts) when they need a specific
// match state.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
