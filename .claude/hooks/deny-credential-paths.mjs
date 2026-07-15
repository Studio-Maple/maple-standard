#!/usr/bin/env node
// PreToolUse hook for Read — blocks reads of credential-bearing files.
//
// Exit code 2 signals "block this tool invocation". Exit 0 = allow.
//
// The patterns are deliberately specific. We don't block `.env.example` or
// docs/ files which legitimately discuss these formats; only the actual
// secret-bearing paths. Generic to any project.
//
// If there's a genuine need to read one of these (e.g. confirming a path
// exists, debugging a hook), the user can grant per-call permission via the
// standard "do you want to allow this" prompt — this hook just makes the
// deny the default.

const DENIED_PATTERNS = [
  // Claude Code's own credentials (OAuth tokens, MCP grants)
  /\.claude[/\\]\.credentials\.json$/i,

  // Supabase / Vercel / any project env files
  /\.env(\..*)?$/i,
  /\.env\.local$/i,
  /\.vercel[/\\].*\.env.*$/i,

  // Cloud provider secrets
  /\.aws[/\\]credentials$/i,
  /\.aws[/\\]config$/i,
  /\.ssh[/\\]id_(rsa|ed25519|ecdsa|dsa)$/i,
  /\.ssh[/\\]known_hosts$/i,
  /\.docker[/\\]config\.json$/i,
  /\.npmrc$/i,
  /\.netrc$/i,
  /\.git-credentials$/i,

  // GitHub CLI
  /gh[/\\]hosts\.yml$/i,

  // Windows credential vault dumps (PowerShell saves)
  /cred(ential)?s?\.xml$/i,
  /cred(ential)?s?\.txt$/i,
];

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const filePath = payload?.tool_input?.file_path ?? payload?.input?.file_path ?? '';
  if (typeof filePath !== 'string' || !filePath) {
    process.exit(0);
  }

  for (const re of DENIED_PATTERNS) {
    if (re.test(filePath)) {
      process.stderr.write(
        `BLOCKED: ${filePath} is a credential-bearing path. ` +
        `If you genuinely need this, ask the user to grant permission explicitly ` +
        `or use a wrapper that doesn't expose the contents to the model's context.\n`,
      );
      process.exit(2);
    }
  }

  process.exit(0);
});
