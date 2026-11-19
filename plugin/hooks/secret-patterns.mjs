// The ONE secret-pattern catalog of the plugin (D070 ports every EasyCaller pattern). Used by the
// scrub-secrets PostToolUse hook (redact tool output) and by secret-write-guard (deny secrets in text an
// agent writes). Add a pattern here once and both sides learn it. Comments on each pattern's design live
// in scrub-secrets.mjs's header.

export const PATTERNS = [
  { name: 'sb_pat',          re: /sbp_(?!oauth_)[a-zA-Z0-9]{30,}/g },
  { name: 'sb_oauth_access', re: /sbp_oauth_[a-zA-Z0-9]{30,}/g },
  { name: 'sb_oauth_secret', re: /sba_[a-zA-Z0-9]{30,}/g },
  { name: 'anthropic',       re: /sk-ant-[a-zA-Z0-9_-]{40,}/g },
  { name: 'jwt',             re: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/g },
  { name: 'gh_pat',          re: /ghp_[a-zA-Z0-9]{30,}/g },
  { name: 'gh_fgpat',        re: /github_pat_[a-zA-Z0-9_]{50,}/g },
  { name: 'aws_key',         re: /AKIA[A-Z0-9]{16}/g },
  { name: 'sb_secret_key',   re: /sb_secret_[a-zA-Z0-9_-]{20,}/g },
  // Boundaries so ordinary words ("ASIAPACIFICREGION...") do not match; STS ids are exactly ASIA + 16.
  { name: 'aws_temp_key',    re: /(?<![A-Z0-9])ASIA[A-Z0-9]{16}(?![A-Z0-9])/g },
  { name: 'aws_secret',
    re: /(?<=(?:aws_secret_access_key|SecretAccessKey)["'\s:=]{0,5})[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/gi,
    requireSubstring: ['secret_access_key', 'secretaccesskey'] },
  { name: 'aws_session',
    re: /(?<=(?:aws_session_token|SessionToken)["'\s:=]{0,5})[A-Za-z0-9/+][A-Za-z0-9/+=]{99,}/gi,
    requireSubstring: ['session_token', 'sessiontoken'] },
  { name: 'cf_api_token',
    re: /(?<=(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN)["'\s:=]{0,5})[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])/gi,
    requireSubstring: 'api_token' },
  { name: 'cf_global_key',
    re: /(?<=(?:CLOUDFLARE_API_KEY|X-Auth-Key)["'\s:=]{0,5})[a-f0-9]{37}(?![a-f0-9])/gi,
    requireSubstring: ['cloudflare_api_key', 'x-auth-key'] },
  // ReDoS fix: the old `(?=.*vercel)` lookahead re-scans from EVERY 24-char
  // candidate to the end of the current line (`.` doesn't cross newlines
  // even without the `s` flag) — on one long line (a minified blob, a huge
  // log line with no newlines) that's O(n) per candidate, ~O(n^2) overall;
  // reviewer measured ~1s/100KB against this hook's 5s timeout. Two fixes,
  // applied together: (1) `requireSubstring` below skips this pattern
  // entirely when "vercel" doesn't appear anywhere in the text — the common
  // case, one cheap indexOf instead of a regex pass; (2) the lookahead
  // itself is now bounded to 200 chars instead of the rest of the line, so
  // even a text that DOES contain "vercel" somewhere can't force a
  // full-remaining-line rescan per candidate.
  { name: 'vercel_token',    re: /\b[A-Za-z0-9]{24}\b(?=.{0,200}vercel)/gi, requireSubstring: 'vercel' },
];

/** Replace every catalog match with [REDACTED:<kind>]. */
export function scrub(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  let lower = null;
  for (const { name, re, requireSubstring } of PATTERNS) {
    if (requireSubstring) {
      lower ??= out.toLowerCase();
      const needles = Array.isArray(requireSubstring) ? requireSubstring : [requireSubstring];
      if (!needles.some((n) => lower.includes(n))) continue;
    }
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
}

/** Names of the catalog patterns that match `text` (empty when clean). */
export function secretKinds(text) {
  if (typeof text !== 'string' || !text) return [];
  const kinds = [];
  let lower = null;
  for (const { name, re, requireSubstring } of PATTERNS) {
    if (requireSubstring) {
      lower ??= text.toLowerCase();
      const needles = Array.isArray(requireSubstring) ? requireSubstring : [requireSubstring];
      if (!needles.some((n) => lower.includes(n))) continue;
    }
    re.lastIndex = 0;
    if (re.test(text)) kinds.push(name);
    re.lastIndex = 0;
  }
  return kinds;
}
