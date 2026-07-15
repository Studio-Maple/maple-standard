// Sentry Edge runtime init — Edge middleware, edge Route Handlers. Imported
// from src/instrumentation.ts when NEXT_RUNTIME=edge. The edge runtime has a
// smaller API surface than Node — keep this file minimal (no Node-only
// integrations).
import * as Sentry from "@sentry/nextjs";

import { shouldDropEvent } from "@/lib/sentryNoiseFilter";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  beforeSend(event) {
    return shouldDropEvent(event) ? null : event;
  },
});
