#!/usr/bin/env node
// PostToolUse hook — scrubs secret-shaped strings from tool output before
// they reach the model's context (and therefore the provider's request
// logs). The pattern catalog is conservative and generic to any project.
//
// Triggered for: Bash, Read, Grep, ToolResult
// Receives:  JSON via stdin describing the tool invocation + result
// Returns:   modified JSON via stdout
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
//
// False positive policy: docs explaining these formats may contain literal
// examples. We bypass scrubbing for outputs whose `file_path` (Read tool)
// is under `docs/` — those are intentionally for human consumption.
//
// Setup: registered in .claude/settings.json under hooks.PostToolUse.

const PATTERNS = [
  { name: 'sb_pat',          re: /sbp_(?!oauth_)[a-zA-Z0-9]{30,}/g },
  { name: 'sb_oauth_access', re: /sbp_oauth_[a-zA-Z0-9]{30,}/g },
  { name: 'sb_oauth_secret', re: /sba_[a-zA-Z0-9]{30,}/g },
  { name: 'anthropic',       re: /sk-ant-[a-zA-Z0-9_-]{40,}/g },
  { name: 'jwt',             re: /eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/g },
  { name: 'gh_pat',          re: /ghp_[a-zA-Z0-9]{30,}/g },
  { name: 'gh_fgpat',        re: /github_pat_[a-zA-Z0-9_]{50,}/g },
  { name: 'aws_key',         re: /AKIA[A-Z0-9]{16}/g },
  { name: 'vercel_token',    re: /\b[A-Za-z0-9]{24}\b(?=.*vercel)/gi },
];

function scrub(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${name}]`);
  }
  return out;
}

function isDocsRead(payload) {
  const filePath = payload?.tool_input?.file_path
    ?? payload?.input?.file_path
    ?? '';
  return typeof filePath === 'string' && /(^|[/\\])docs[/\\]/.test(filePath);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // If we can't parse, pass through unchanged. Failing the hook would
    // block tool execution which is worse than a missed scrub.
    process.stdout.write(raw);
    process.exit(0);
  }

  if (isDocsRead(payload)) {
    process.stdout.write(JSON.stringify(payload));
    process.exit(0);
  }

  if (payload?.tool_response) {
    if (typeof payload.tool_response === 'string') {
      payload.tool_response = scrub(payload.tool_response);
    } else if (typeof payload.tool_response === 'object') {
      if (typeof payload.tool_response.output === 'string') {
        payload.tool_response.output = scrub(payload.tool_response.output);
      }
      if (typeof payload.tool_response.stdout === 'string') {
        payload.tool_response.stdout = scrub(payload.tool_response.stdout);
      }
      if (typeof payload.tool_response.stderr === 'string') {
        payload.tool_response.stderr = scrub(payload.tool_response.stderr);
      }
      if (typeof payload.tool_response.content === 'string') {
        payload.tool_response.content = scrub(payload.tool_response.content);
      }
    }
  }

  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
});
