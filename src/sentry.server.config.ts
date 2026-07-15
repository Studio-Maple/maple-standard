// Sentry Node runtime init — Server Components, Route Handlers, Server
// Actions. Imported from src/instrumentation.ts when NEXT_RUNTIME=nodejs.
import * as Sentry from "@sentry/nextjs";

import { shouldDropEvent } from "@/lib/sentryNoiseFilter";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  // 100% in dev (cheap, useful locally) — 10% in prod (cost-bounded; raise
  // per-route with Sentry.startSpan if you need deeper prod traces).
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  beforeSend(event) {
    return shouldDropEvent(event) ? null : event;
  },
});
