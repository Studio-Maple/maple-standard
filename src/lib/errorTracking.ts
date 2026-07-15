/**
 * Public error-tracking entry point. Every call site in the app imports
 * FROM HERE, never `@sentry/nextjs` directly — that keeps the Sentry
 * dependency swappable and gives us one place to add side-channels later
 * (e.g. logging RLS 42501s to `rls_violations` — see
 * supabase/migrations/*_rls_violations.sql).
 *
 * `@sentry/nextjs` is safe to import in Client Components, Server
 * Components, Route Handlers, and Edge middleware alike — the SDK
 * multiplexes on `instrumentation.ts` / `instrumentation-client.ts` having
 * already called `Sentry.init()` for the current runtime. No SSR-unsafe
 * dynamic import dance is needed (unlike a bundler without a Next.js-aware
 * SDK build).
 */
import * as Sentry from "@sentry/nextjs";

export type ErrorCategory =
  | "network"
  | "auth"
  | "database"
  | "validation"
  | "rendering"
  | "unknown";

export interface LogErrorOptions {
  userId?: string | null;
  tags?: Record<string, string | number | boolean | undefined>;
  extra?: Record<string, unknown>;
}

/** Capture an exception with optional Sentry-shaped context. */
export function captureException(error: unknown, context?: Record<string, unknown>): void {
  Sentry.captureException(error, context);
}

/** Capture a message (e.g. a `logger.warn` path) instead of a thrown error. */
export function captureMessage(message: string, context?: Record<string, unknown>): void {
  Sentry.captureMessage(message, context);
}

/**
 * Tag + capture an error under a coarse category, with an optional user id
 * and Sentry tags/extra. Prefer this to a raw `captureException` call so
 * every reported error carries a consistent `category` tag for grouping.
 */
export function logError(
  error: Error,
  category: ErrorCategory,
  options?: string | null | LogErrorOptions
): void {
  const opts: LogErrorOptions =
    typeof options === "string" || options === null || options === undefined
      ? { userId: options ?? undefined }
      : options;

  captureException(error, {
    tags: { category, ...(opts.tags ?? {}) },
    user: opts.userId ? { id: opts.userId } : undefined,
    extra: opts.extra,
  });
}

/** Set the current user context for error tracking (call on login). */
export function setErrorTrackingUser(id: string, email?: string): void {
  Sentry.setUser({ id, email });
}

/** Clear the user context (call on logout). */
export function clearErrorTrackingUser(): void {
  Sentry.setUser(null);
}

/** Tag the active scope with a page/route name for grouping in Sentry. */
export function setPageTag(name: string): void {
  Sentry.getCurrentScope().setTag("page", name);
}

/**
 * Deterministic 4-char uppercase hex code from an error's message + stack
 * (djb2 hash). Useful for showing the user a short, matchable code in an
 * error boundary UI without exposing the full stack.
 */
export function computeErrorCode(message: string, stack?: string): string {
  const input = `${message}${stack ?? ""}`;
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
    hash = hash & hash; // force 32-bit signed integer
  }
  return Math.abs(hash).toString(16).toUpperCase().slice(0, 4).padStart(4, "0");
}
