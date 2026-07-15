// Sentry browser init. Next.js auto-loads `instrumentation-client.ts` before
// the app's client-side code runs (Next.js 15.3+ convention — replaces the
// older `sentry.client.config.ts` pattern).
import * as Sentry from "@sentry/nextjs";

import { shouldDropEvent } from "@/lib/sentryNoiseFilter";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  integrations: [Sentry.replayIntegration({ maskAllText: false, blockAllMedia: true })],
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  beforeSend(event) {
    return shouldDropEvent(event) ? null : event;
  },
});

// Tracks App Router client-side navigations as Sentry transactions.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
