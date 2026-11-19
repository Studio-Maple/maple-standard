// Guard: the credential store is reachable ONLY through `maple-secret` (D085). Always enforce: a warn
// would let the command run, and the secret would already be in the model's context.
//
// Denies any shell command (Bash | PowerShell | MCP shells, which arrive as PowerShell) that reaches the
// store directly: Get-StoredCredential, GetNetworkCredential, `.Password` on a credential object,
// CredRead/CredEnumerate, PasswordVault, vaultcmd, Marshal.PtrToString*/SecureStringTo*,
// ConvertFrom-SecureString -AsPlainText, `security find-*-password -w|-g`, `secret-tool lookup`,
// cmdkey writes (`/generic`, `/add`, `/pass`; owner path = store-secret.ps1), and node/powershell code
// that imports plugin `credentials.mjs` / calls `getCredential(`.
// Allowed: `cmdkey /list`, `maple-secret.mjs run|exists|list`, the predeploy runner, store-secret.ps1
// (none of them put a denied token on the command line) and text that merely MENTIONS the names:
// commit/PR messages, echo text, heredoc bodies, and search commands (grep/rg/git grep/Select-String).
import { inspectableArgs, isDataOnly } from "./shell.mjs";

const SEP = "\u0001"; // between segments, so a rule never matches across two commands by accident
const NO_SEP = `[^${SEP}]*`;

const REPLACE =
  'Use the wrapper (D085): node "$CLAUDE_PLUGIN_ROOT/scripts/secrets/maple-secret.mjs" run --env NAME=<Target> [--file NAME=<Target>] -- <command>' +
  ' (existence: ... maple-secret.mjs exists <Target>; names: ... maple-secret.mjs list). The wrapper puts the value in the child process only and redacts it from output.';

// [regex on the lower-cased joined code text, what to name in the message, powershell-context only?]
const RULES = [
  [/get-storedcredential/, "Get-StoredCredential"],
  [/getnetworkcredential/, "GetNetworkCredential"],
  [/\bcred(?:read|enumerate)/, "CredRead/CredEnumerate (advapi32)"],
  [/windows\.security\.credentials|passwordvault/, "Windows.Security.Credentials.PasswordVault"],
  [/\bvaultcmd\b/, "vaultcmd"],
  [/ptrtostring(?:bstr|auto|uni|ansi)|securestringto(?:bstr|globalalloc\w*)/, "Marshal PtrToString*/SecureStringTo* (SecureString -> plaintext)"],
  [/convertfrom-securestring[\s\S]*-asplaintext|-asplaintext[\s\S]*convertfrom-securestring/, "ConvertFrom-SecureString -AsPlainText"],
  [new RegExp(`\\bsecurity(?:\\.exe)?\\s+find-(?:generic|internet)-password${NO_SEP}\\s-[a-z]*[wg]`), "security find-*-password -w/-g"],
  [/\bsecret-tool\s+(?:lookup|search)\b/, "secret-tool lookup"],
  [new RegExp(`\\bcmdkey(?:\\.exe)?\\s+${NO_SEP}/(?:add|generic|pass|delete|smartcard)\\b`), "cmdkey write (/generic, /add, /pass, /delete; the owner path is store-secret.ps1)"],
  // importing the helper (not naming its file: `cat`, `git add`, a test run of it stay allowed)
  [/(?:\bimport\b|\brequire\s*\()[^;\u0001]*credentials\.mjs|\bgetcredential\s*\(/, "plugin credentials.mjs / getCredential()"],
  [new RegExp(`(?:\\bcred\\w*|\\bget-credential\\b${NO_SEP})[\\s${SEP}]*\\.password\\b`), ".Password on a credential object", true],
];

// Segments whose arguments are search patterns / messages, never code.
const SEARCH_VERBS = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "select-string", "sls", "findstr", "sed", "man", "help", "get-help"]);
const PS_VERBS = new Set(["powershell", "pwsh", "iex", "invoke-expression"]);
const INTERPRETERS = new Set([...PS_VERBS, "node", "python", "python3", "bash", "sh", "zsh", "cmd", "deno", "bun", "tsx", "ruby", "perl"]);
const ENC_FLAG = /^-(e|ec|enc|encodedcommand)$/i;

function decodeEncoded(seg) {
  const out = [];
  seg.args.forEach((a, i) => {
    if (!ENC_FLAG.test(a.text) || !seg.args[i + 1]) return;
    try { out.push(Buffer.from(seg.args[i + 1].text, "base64").toString("utf16le")); } catch { /* not base64 */ }
  });
  return out;
}

/** The text a guard rule is allowed to see: code, not data. */
function codeText(ctx) {
  const parts = [];
  let ps = ctx.shell === "powershell";
  let interpreter = false;
  for (const seg of ctx.segments()) {
    if (PS_VERBS.has(seg.verb)) ps = true;
    if (INTERPRETERS.has(seg.verb)) interpreter = true;
    if (SEARCH_VERBS.has(seg.verb)) continue;
    if (seg.verb === "git") { // messages / patterns are data; only `git config` can smuggle a command (alias)
      if (seg.args[0]?.text.toLowerCase() === "config") parts.push(seg.words.map((w) => w.text).join(" "));
      continue;
    }
    // echo / Write-Host text is data in bash; in PowerShell its UNQUOTED words are expressions
    const words = isDataOnly(seg)
      ? (ctx.shell === "powershell" ? seg.args.filter((w) => !w.quoted) : [])
      : inspectableArgs(seg);
    parts.push([...(isDataOnly(seg) ? [] : [seg.words[0].text]), ...words.map((w) => w.text)].join(" "));
    parts.push(...decodeEncoded(seg));
  }
  // heredoc / here-string bodies are dropped by the tokenizer: if an interpreter could consume one, scan the raw command
  if (interpreter && /<<|@['"]/.test(ctx.command)) parts.push(ctx.command);
  return { text: parts.join(SEP).toLowerCase(), ps };
}

export function check(ctx) {
  if (!ctx.command) return undefined;
  const { text, ps } = codeText(ctx);
  for (const [re, name, psOnly] of RULES) {
    if (psOnly && !ps) continue;
    if (re.test(text)) {
      return { deny: `BLOCKED (credential-store-guard, D085): ${name} reads the credential store directly. The maple-secret wrapper is the only retrieval path. ${REPLACE}` };
    }
  }
  return undefined;
}

/** On an internal error, still refuse anything that smells like store access. */
export function failClosed(ctx, why) {
  if (/credential|vault|cred(?:read|enum)|securestring|cmdkey|secret-tool|find-(?:generic|internet)-password|getcredential/i.test(ctx.command ?? "")) {
    return { deny: `BLOCKED (credential-store-guard, D085): ${why}; a command that may touch the credential store is refused. ${REPLACE}` };
  }
  return undefined;
}
