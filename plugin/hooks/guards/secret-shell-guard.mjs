// Guard: shell commands that PRINT a secret into the model's context (D082: always enforced, no warn phase).
//
// Using a secret is fine (`curl -H "Authorization: Bearer $TOKEN"` sends it, it does not print it).
// Printing one is not, because tool output is model context and provider logs. Denied:
//   - a printing verb (echo, printf, Write-Output, Write-Host, ...) or a bare PowerShell `$env:X` statement
//     whose argument expands a secret-named variable ($X, ${X}, $env:X)
//   - reading a secret-named variable through a provider/API: Get-Item/Get-Content env:X, printenv X,
//     [Environment]::GetEnvironmentVariable("X"), an inline node/python/deno one-liner that prints process.env.X
//   - whole-environment dumps: env, printenv, set, export -p, declare -p/-x, Get-ChildItem/ls/dir env:
//   - CLIs whose job is to print a credential: gh auth token, gcloud auth print-access-token, az account
//     get-access-token, aws configure get/export-credentials, aws sts get-session-token, heroku auth:token,
//     op read / op item get --reveal, bw get password, vercel env pull to stdout, ...
//   - naming a credential-bearing file with any verb (~/.aws/credentials, ~/.netrc, ~/.git-credentials,
//     gh hosts.yml, ~/.docker/config.json, .npmrc; .env* is already deny-credential-paths)
// Secret-named = a name with a TOKEN / SECRET / PASSWORD / PASS / KEY / CREDENTIAL / PAT / DSN / COOKIE part
// (split on _), unless a PUBLIC / PUBLISHABLE / ANON part marks it as public by design.
import { isCredentialPath } from "./deny-credential-paths.mjs";

const PRINT_VERBS = new Set(["echo", "printf", "print", "write-output", "write-host", "write-information", "write-verbose", "write-debug", "write-warning", "write-error", "out-host", "out-string", "out-file", "set-content", "add-content", "tee", "tee-object"]);
const SECRET_PART = /^(TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|PASS|PASSPHRASE|KEY|APIKEY|PRIVATEKEY|CREDENTIAL|CREDENTIALS|CREDS|PAT|DSN|COOKIE|BEARER|AUTHTOKEN|CLIENTSECRET|SIGNINGKEY|WEBHOOKSECRET)$/;
const PUBLIC_PART = /^(PUBLIC|PUBLISHABLE|ANON|PUB)$/;
const VAR_REF = /\$\{?(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}?/gi;
const ENV_READ = /(?:process\.env(?:\.|\[\s*["'])|os\.environ(?:\.get\(\s*|\[\s*)["']|os\.getenv\(\s*["']|Deno\.env\.get\(\s*["']|getenvironmentvariable\(\s*["']|env:)([A-Za-z_][A-Za-z0-9_]*)/gi;
const ONE_LINER_PRINT = /console\.(log|info|error|warn|dir)|process\.std(out|err)\.write|\bprint\s*\(|sys\.std(out|err)\.write/i;
const INLINE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "eval"]);

/** True when an environment variable name is secret-shaped and not public by design. */
export function isSecretName(name) {
  const parts = String(name).toUpperCase().split(/_+/).filter(Boolean);
  if (parts.some((p) => PUBLIC_PART.test(p))) return false;
  return parts.some((p) => SECRET_PART.test(p));
}

function secretRefs(text) {
  const out = [];
  for (const m of String(text).matchAll(VAR_REF)) if (isSecretName(m[1])) out.push(m[1]);
  return out;
}

function secretEnvReads(text) {
  const out = [];
  for (const m of String(text).matchAll(ENV_READ)) if (isSecretName(m[1])) out.push(m[1]);
  return out;
}

/** Remove quoted strings so a raw-text check never fires on a commit message or other data. */
function stripQuoted(cmd) {
  return cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\`]|\\.|`.)*"/g, '""');
}

// Raw-text checks for verbs the tokenizer folds away (`env` is a wrapper prefix to it).
const DUMP_RAW = /(^|[|;&(]\s*|\n\s*)(env|printenv|set|export\s+-p|declare\s+-[a-z]*[px][a-z]*|typeset\s+-x|compgen\s+-e)\s*(?=$|[|;&)>\n])/i;
const CRED_CLI = [
  [/\bgh\s+auth\s+(token|status\b[^|;&]*(--show-token|\s-t\b))/i, "gh auth token"],
  [/\bgcloud\s+auth\s+(application-default\s+)?print-(access|identity)-token/i, "gcloud auth print-access-token"],
  [/\baz\s+account\s+get-access-token/i, "az account get-access-token"],
  [/\baws\s+configure\s+(get\s+\S*(secret|token|key)|export-credentials)/i, "aws configure get/export-credentials"],
  [/\baws\s+sts\s+get-session-token|\baws\s+sts\s+assume-role\b/i, "aws sts (prints temporary credentials)"],
  [/\baws\s+ecr\s+get-login-password/i, "aws ecr get-login-password"],
  [/\bheroku\s+auth:token/i, "heroku auth:token"],
  [/\bop\s+(read\b|item\s+get\b[^|;&]*--reveal)/i, "1Password op read / --reveal"],
  [/\bbw\s+get\s+(password|totp|notes)\b/i, "Bitwarden bw get"],
  [/\bvercel\s+env\s+pull\b[^|;&]*(\/dev\/stdout|\s-\s*$)/i, "vercel env pull to stdout"],
  [/\bsupabase\s+(projects\s+api-keys|secrets\s+list)\b[^|;&]*(-o|--output)\s+(json|env|yaml)\b/i, "supabase api-keys with values"],
  [/\bwrangler\s+secret\s+get\b/i, "wrangler secret get"],
  [/\bnpm\s+token\s+create\b/i, "npm token create (prints the new token)"],
  [/\bgit\s+credential\s+fill\b/i, "git credential fill"],
];

function deny(what) {
  return {
    deny:
      `BLOCKED (secret-shell-guard): ${what} would print a secret into the model's context (tool output reaches the provider's logs). ` +
      "Use the secret without printing it (pass it to the command that needs it), or run the command through the plugin's maple-secret wrapper, which redacts the value (D085). " +
      "To check a variable is set, print only its presence or length: `[ -n \"$X\" ] && echo set` / `[bool]$env:X`.",
  };
}

export function check(ctx) {
  const raw = stripQuoted(ctx.command || "");
  if (DUMP_RAW.test(raw)) return deny("dumping the whole environment");
  for (const [re, label] of CRED_CLI) if (re.test(raw)) return deny(`\`${label}\``);

  for (const seg of ctx.segments()) {
    const verb = seg.verb || "";
    const args = seg.args || [];
    const words = seg.words || [];
    // bare PowerShell `$env:X` / `${env:X}` statement prints the value
    // (an assignment `$env:X = ...` / `$env:X='v'` sets it and prints nothing)
    if (/^\$\{?env:[a-z_][a-z0-9_]*\}?$/i.test(verb) && !(args[0] && /^[+-]?=/.test(args[0].text))) {
      const refs = secretRefs(words[0]?.text ?? verb);
      if (refs.length) return deny(`\`$env:${refs[0]}\``);
    }
    if (PRINT_VERBS.has(verb)) {
      for (const a of args) {
        const refs = secretRefs(a.text);
        if (refs.length) return deny(`\`${verb} $${refs[0]}\``);
      }
    }
    if (verb === "printenv") {
      if (!args.length) return deny("`printenv`");
      const hit = args.find((a) => isSecretName(a.text));
      if (hit) return deny(`\`printenv ${hit.text}\``);
    }
    if (["gci", "get-childitem", "ls", "dir", "get-item", "gi", "get-content", "gc", "cat", "type"].includes(verb)) {
      for (const a of args) {
        const t = a.text.replace(/^env:[\\/]?/i, "env:");
        if (/^env:$/i.test(t)) return deny(`\`${verb} env:\``);
        const m = /^env:([A-Za-z_][A-Za-z0-9_]*)/i.exec(t);
        if (m && isSecretName(m[1])) return deny(`\`${verb} env:${m[1]}\``);
      }
    }
    // inline one-liners: node -e / python -c / deno eval that both read a secret env var and print
    const inline = args.findIndex((a) => INLINE_FLAGS.has(a.text));
    if (inline >= 0 && args[inline + 1]) {
      const code = args[inline + 1].text;
      const reads = secretEnvReads(code);
      if (reads.length && ONE_LINER_PRINT.test(code)) return deny(`an inline script printing ${reads[0]}`);
    }
    for (const w of words) {
      const reads = /getenvironmentvariable/i.test(w.text) ? secretEnvReads(w.text) : [];
      if (reads.length && !w.quoted) return deny(`[Environment]::GetEnvironmentVariable("${reads[0]}")`);
    }
    // credential-bearing files beyond .env* (deny-credential-paths covers those), any verb
    if (!["echo", "printf", "write-host", "write-output"].includes(verb)) {
      for (const a of args) {
        if (a.quoted && /\s/.test(a.text)) continue; // a message, not a path
        if (isCredentialPath(a.text) && !/known_hosts$|\.env(\.|$)|\.dev\.vars|\.pem$|id_(rsa|ed25519|ecdsa|dsa)$/i.test(a.text)) {
          return deny(`reading ${a.text}`);
        }
      }
    }
  }
  return undefined;
}
