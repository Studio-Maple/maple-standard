/**
 * Pure, framework-free helpers. `lib/` must never import React or services/ —
 * enforced by dependency-cruiser (see .dependency-cruiser.cjs). If you need
 * data at runtime, do it in a hook or component instead.
 */

/** Join class names, skipping falsy values. Small, dependency-free `clsx` substitute. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/** Format a Date as `YYYY-MM-DD` (UTC), the convention used across migrations/docs. */
export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Clamp a number to an inclusive [min, max] range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
