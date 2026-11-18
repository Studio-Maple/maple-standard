// scrub.mjs - redact secrets from scanner output before it is kept on disk (live-scan ZAP log and report).
// ZAP can echo the request headers of failed-auth requests into its container log and its JSON report, so every
// injected credential value, any auth-looking header and any JWT is replaced. Pure; no I/O.

const HEADER_RE = /((?:authorization|proxy-authorization|cookie|set-cookie|x-ingest-secret|cf-access-client-id|cf-access-client-secret)\s*[:=]\s*)[^\r\n"]+/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g;

/** @param {string} text @param {Iterable<string>} values the injected credential values (short ones are ignored) */
export function scrubSecrets(text, values = []) {
  let out = String(text);
  for (const v of values) {
    const s = String(v || "");
    if (s.length >= 8) out = out.split(s).join("[REDACTED]");
  }
  return out.replace(HEADER_RE, "$1[REDACTED]").replace(JWT_RE, "[REDACTED-JWT]");
}
