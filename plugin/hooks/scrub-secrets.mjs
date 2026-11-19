#!/usr/bin/env node
import { scrub } from './secret-patterns.mjs';
// PostToolUse hook — scrubs secret-shaped strings from tool output before
// they reach the model's context (and therefore the provider's request
// logs). Part of the maple-standard plugin (plugin/hooks/hooks.json).
//
// Triggered for: Bash, PowerShell, Read, Grep
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
//   Supabase secret key   sb_secret_<20+>          (new key format; sb_publishable_ is NOT a secret and is left alone)
//   AWS temporary key     ASIA<16>                 (STS access key id)
//   AWS secret key        40 chars, only when labeled aws_secret_access_key / SecretAccessKey
//   AWS session token     100+ base64 chars, only when labeled aws_session_token / SessionToken
//   Cloudflare API token  40 chars, only when labeled CLOUDFLARE_API_TOKEN / CF_API_TOKEN
//   Cloudflare global key 37 hex, only when labeled CLOUDFLARE_API_KEY / X-Auth-Key
// The AWS/Cloudflare values are context-bound (lookbehind on the label) because bare 40-char strings
// false-positive constantly: git SHAs are 40 hex chars and show up in every deploy log.
//
// docs/ IS scrubbed like everything else. It used to be exempt so pattern EXAMPLES stayed readable, which also
// meant a real secret pasted into a doc reached model context unredacted (EasyCaller audit 12 L5, restored here
// after D065 removed the project copies that had fixed it). An example that matches a pattern is redacted too;
// that costs nothing, and docs should use values that are obviously fake and do not match.
//
// This hook ports EVERY pattern of EasyCaller's former project copy; there is no second copy to keep in sync.
//



/** Scrub every string inside a JSON-shaped value, keeping its structure. */
function deepScrub(v, depth = 0) {
  if (typeof v === 'string') return scrub(v);
  if (depth > 20 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => deepScrub(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepScrub(x, depth + 1)]));
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

  // MCP tools (D082): the result is usually structured (content blocks), and a replacement must keep the
  // tool's output shape, so every string inside it is scrubbed in place and the same structure goes back.
  if (typeof payload?.tool_name === 'string' && payload.tool_name.startsWith('mcp__')) {
    const original = payload.tool_response ?? payload.tool_output;
    if (original !== undefined && original !== null && typeof original === 'object') {
      const scrubbedTree = deepScrub(original);
      if (JSON.stringify(scrubbedTree) === JSON.stringify(original)) process.exit(0);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: scrubbedTree, updatedToolOutput: scrubbedTree },
      }));
      process.exit(0);
    }
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
