// Next.js instrumentation hook — registers the Sentry SDK for whichever
// server runtime is active, and wires `onRequestError` so uncaught errors
// in Server Components / Route Handlers / Server Actions reach Sentry even
// when no try/catch calls `captureException` explicitly.
//
// docs: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
