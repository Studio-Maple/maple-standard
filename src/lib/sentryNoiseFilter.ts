/**
 * Shared `beforeSend` noise filter for Sentry — used by both
 * `instrumentation-client.ts` (browser) and `sentry.server.config.ts` /
 * `sentry.edge.config.ts` (server/edge) so the drop rules live in exactly
 * one place. Kept intentionally generic (no project-specific domains) —
 * add project-specific rules here as you discover real noise, and document
 * why in a comment next to the rule (a rule with no reasoning rots).
 *
 * Trimmed to the
 * genuinely stack-agnostic subset (browser-extension noise, transient
 * network blips) — project-specific drop rules belong to each project.
 */
import type { Event as SentryEvent } from "@sentry/nextjs";

const NOISY_MESSAGE_PATTERNS: RegExp[] = [
  // Browser extensions injecting scripts into the page — never actionable.
  /chrome-extension:\/\//i,
  /moz-extension:\/\//i,
  /safari-extension:\/\//i,
  // Benign browser quirk with no user-facing impact (Chrome/Safari).
  /ResizeObserver loop limit exceeded/i,
  /ResizeObserver loop completed with undelivered notifications/i,
  // Cross-origin script errors with no stack trace — nothing to act on.
  /^Script error\.?$/i,
];

function eventText(event: SentryEvent): string {
  const messages: string[] = [];
  if (event.message) messages.push(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) messages.push(ex.value);
  }
  return messages.join(" \n ");
}

function hasExtensionFrame(event: SentryEvent): boolean {
  for (const ex of event.exception?.values ?? []) {
    for (const frame of ex.stacktrace?.frames ?? []) {
      if (frame.filename && /^(chrome|moz|safari)-extension:\/\//i.test(frame.filename)) {
        return true;
      }
    }
  }
  return false;
}

/** Returns true when the event should be dropped (never sent to Sentry). */
export function shouldDropEvent(event: SentryEvent): boolean {
  const text = eventText(event);
  if (NOISY_MESSAGE_PATTERNS.some((re) => re.test(text))) return true;
  if (hasExtensionFrame(event)) return true;
  return false;
}
