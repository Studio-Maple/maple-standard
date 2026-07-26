#!/usr/bin/env node
// PostToolUse hook — scrubs secret-shaped strings from tool output before
// they reach the model's context (and therefore the provider's request
// logs). Part of the maple-standard plugin (plugin/hooks/hooks.json).
//
// Triggered for: Bash, Read, Grep
// Receives:  JSON via stdin describing the tool invocation + result
// Returns:   a hookSpecificOutput.updatedToolOutput rewrite (see MJ-5 below),
//            or nothing at all when there's nothing to scrub
//
// MJ-5: this hook used to mutate `payload.tool_response` in place and write
// the WHOLE payload back to stdout. `tool_response` is INPUT ONLY — Claude
// Code reads a PostToolUse hook's stdout for the hook's OWN JSON control
// fields, never as if it were the (possibly-edited) original tool result.
// Nothing was ever actually redacted from what Claude sees; the hook was a
// silent no-op wearing a scrubber's clothes.
//
// The real mechanism (verified against the current Claude Code hooks
// reference, https://code.claude.com/docs/en/hooks.md, checked 2026-07-26 —
// do not re-derive this from memory, the contract has changed before):
// PostToolUse can replace what Claude sees by printing
//   {"hookSpecificOutput":{"hookEventName":"PostToolUse","updatedToolOutput":"<text>"}}
// where `updatedToolOutput` is a STRING — every documented example is a
// plain string, including for tools whose raw result is structured (e.g.
// Write's example tool_output is the string "File created successfully",
// not an object). The docs describe the hook's own tool-result input field
// as `tool_output` (also a string in every example); this file also checks
// the older `tool_response` shape ({output|stdout|stderr|content} or a bare
// string) some earlier Claude Code versions used, purely for robustness —
// but the OUTPUT this hook emits is always the one documented shape: a
// single string, full replacement (the docs don't document or show a
// structured/partial `updatedToolOutput`, so this hook doesn't invent one).
//
// We replace every match of known secret regex patterns with [REDACTED:<kind>]
// so context still parses as readable text. Pattern catalog is conservative —
// only high-confidence shapes with very few false positives:
//
//   Supabase PAT          sbp_<40+ hex/alphanum>
//   Supabase OAuth secret sba_<40+ hex/alphanum>
//   Supabase OAuth access sbp_oauth_<40+ hex/alphanum>
//   Anthropic OAuth/API   sk-ant-<long alphanum/dash>
//   JWT (3 base64 dot-sep) eyJ...eyJ...
//   GitHub PAT            ghp_<36+>
//   GitHub fine-grained   github_pat_<50+>
//   AWS access key        AKIA<16>
//   Vercel-context token   <24 alnum> near the word "vercel"
//
// False positive policy: docs explaining these formats may contain literal
// examples. We bypass scrubbing for outputs whose `file_path` (Read tool)
// is under the project's docs folder (maple.config.json `docs.root`,
// default "docs") — those are intentionally for human consumption.
//
// PROJECT ROOT: resolved from the hook payload's own `cwd` field (falling
// back to $CLAUDE_PROJECT_DIR, then process.cwd()) — NOT from this script's
// own location. A plugin hook script lives under the plugin's install
// directory, not the adopting project, so `import.meta.url`-relative paths
// would resolve to the wrong place.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function loadMapleConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'maple.config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const PATTERNS = [
  { name: 'sb_pat',          re: /sbp_(?!oauth_)[a-zA-Z0-9]{30,}/g },
  { name: 'sb_oauth_access', re: /sbp_oauth_[a-zA-Z0-9]{30,}/g },
  { name: 'sb_oauth_secret', re: /sba_[a-zA-Z0-9]{30,}/g },
  { name: 'anthropic',       re: /sk-ant-[a-zA-Z0-9_-]{40,}/g },
  { name: 'jwt',             re: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/g },
  { name: 'gh_pat',          re: /ghp_[a-zA-Z0-9]{30,}/g },
  { name: 'gh_fgpat',        re: /github_pat_[a-zA-Z0-9_]{50,}/g },
  { name: 'aws_key',         re: /AKIA[A-Z0-9]{16}/g },
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

function scrub(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  let lower = null;
  for (const { name, re, requireSubstring } of PATTERNS) {
    if (requireSubstring) {
      lower ??= out.toLowerCase();
      if (!lower.includes(requireSubstring)) continue;
    }
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
}

function isDocsRead(payload, docsRoot) {
  const filePath = payload?.tool_input?.file_path
    ?? payload?.input?.file_path
    ?? '';
  if (typeof filePath !== 'string' || !filePath) return false;
  const escaped = docsRoot.replace(/[/\\]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[/\\\\])${escaped}[/\\\\]`).test(filePath);
}

// Flatten whatever shape the tool result arrived in into ONE string —
// `updatedToolOutput` is documented as a full-replacement string (see
// header), not a structured partial update, regardless of the tool's own
// result shape.
//
// m13 (documented intentionally, not a bug): joining tool_response.output /
// .stdout / .stderr / .content with "\n" below LOSES the original field
// boundaries — the scrubbed replacement can no longer say which line came
// from stdout vs. stderr, or reconstruct the exact original structured
// shape. This is accepted on purpose: `updatedToolOutput`'s own contract
// (see header) only ever accepts ONE opaque string, so there is no
// structured slot to preserve those boundaries INTO even if we kept them —
// whatever we emit here is what Claude sees as "the tool's output," full
// stop. The alternative (only scrubbing whichever single field looks most
// "primary" and leaving the others unmodified) would be worse: any secret
// living in a field this hook didn't pick would reach the model unscrubbed.
// Losing field boundaries is an acceptable trade against that.
function extractToolOutputText(payload) {
  if (typeof payload?.tool_output === 'string') return payload.tool_output;
  if (typeof payload?.tool_response === 'string') return payload.tool_response;
  const r = payload?.tool_response;
  if (r && typeof r === 'object') {
    const parts = [];
    if (typeof r.output === 'string') parts.push(r.output);
    if (typeof r.stdout === 'string') parts.push(r.stdout);
    if (typeof r.stderr === 'string') parts.push(r.stderr);
    if (typeof r.content === 'string') parts.push(r.content);
    if (parts.length) return parts.join('\n');
  }
  if (payload?.tool_output && typeof payload.tool_output === 'object') {
    try {
      return JSON.stringify(payload.tool_output);
    } catch {
      return null;
    }
  }
  return null;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Can't parse the payload at all — nothing to rewrite. Exit 0 with no
    // stdout ("allow", per the PostToolUse contract) rather than echoing
    // unparsed raw text back as if it were valid hook JSON output.
    process.exit(0);
  }

  const root = payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cfg = loadMapleConfig(root);
  const docsRoot = cfg?.docs?.root || 'docs';

  if (isDocsRead(payload, docsRoot)) {
    process.exit(0); // intentionally human-facing docs example — leave as-is
  }

  const text = extractToolOutputText(payload);
  if (text === null) process.exit(0); // nothing recognizable to scan

  const scrubbed = scrub(text);
  if (scrubbed === text) process.exit(0); // no match — no-op, don't rewrite for nothing

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: scrubbed,
    },
  }));
  process.exit(0);
});
