#!/usr/bin/env node
/**
 * redact.mjs — local, no-network screen applied to anything built into a
 * Jev `state` payload. Mirrors the masking hermes-jev-skills' jevkit
 * (jevkit/privacy.py, MIT — see plugin/skills/jev-search/NOTICE) documents
 * for its own search/mailbox gates, ported to Node with the same intent:
 * mask, never send, whatever looks like a secret, and keep the payload
 * small.
 *
 * This is a best-effort pattern screen, not a guarantee — callers still
 * decide whether a given `state` is safe to build in the first place
 * (route.mjs / skill-select.mjs / search.mjs never include raw tool output
 * or file contents, only short descriptions).
 */

const PATTERNS = [
  // emails
  [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "[redacted-email]"],
  // long hex strings (tokens, hashes, keys)
  [/\b[a-f0-9]{24,}\b/gi, "[redacted-hex]"],
  // bearer / api-key-shaped tokens
  [/\b(sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[baprs])-[a-z0-9_-]{10,}\b/gi, "[redacted-token]"],
  [/\bBearer\s+[a-z0-9._-]{10,}/gi, "Bearer [redacted-token]"],
  // phone-ish
  [/\b\+?\d[\d\s().-]{8,}\d\b/g, "[redacted-number]"],
];

/** @param {string} text @returns {string} */
export function redact(text) {
  if (typeof text !== "string" || !text) return text ?? "";
  let out = text;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** True when `text` looks sensitive enough that it should not be sent at all. */
export function looksSensitive(text) {
  if (typeof text !== "string") return false;
  return /-----BEGIN [A-Z ]+PRIVATE KEY-----|\bpassword\s*[:=]|\bsecret\s*[:=]/i.test(text);
}

/** Truncate to `max` chars on a clean boundary, marking that it was cut. */
export function clip(text, max = 900) {
  const s = typeof text === "string" ? text : String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[clipped]`;
}
