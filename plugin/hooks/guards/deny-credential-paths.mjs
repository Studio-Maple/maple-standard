// Guard: credential-bearing files (D065). Two entry points, one policy:
//   - Read | Grep | Glob: the file_path / path / glob / pattern the tool call carries.
//   - Bash | PowerShell: ANY command that names a credential file, whatever the verb (cat, type,
//     Get-Content, cp, node -e ..., a redirect target). Quoted commit/PR messages, heredoc bodies and
//     echo/printf text are data and ignored (the tokenizer drops them).
//
// Credential files: `.env`, `.env.*`, `.dev.vars[.*]`, `.credentials.json`, ssh private keys (`id_*`),
// private-key `*.pem`. Example/sample/template variants (`.env.example`) document the shape and pass.
// Read/Grep/Glob additionally cover cloud-provider config files (`.aws/credentials`, `.npmrc`, ...).
//
// Generic to any project; needs no maple.config.json and no cwd resolution.
import { inspectableArgs, isDataOnly } from "./shell.mjs";

const EXEMPT = /\.(example|sample|template)$/i;
const PEM_PUBLIC = /(cert|chain|public|pubkey|\.pub|bundle)/i;

// Path patterns for the Read/Grep/Glob tools (full path or glob string).
const PATH_PATTERNS = [
  /\.claude[/\\]\.credentials\.json$/i,
  /\.env(\..*)?$/i,
  /\.dev\.vars(\..*)?$/i,
  /\.vercel[/\\].*\.env.*$/i,
  /\.aws[/\\]credentials$/i,
  /\.aws[/\\]config$/i,
  /\.ssh[/\\]id_(rsa|ed25519|ecdsa|dsa)$/i,
  /\.ssh[/\\]known_hosts$/i,
  /\.docker[/\\]config\.json$/i,
  /\.npmrc$/i,
  /\.netrc$/i,
  /\.git-credentials$/i,
  /gh[/\\]hosts\.yml$/i,
  /cred(ential)?s?\.xml$/i,
  /cred(ential)?s?\.txt$/i,
  /\.pem$/i,
];

// A credential file NAMED somewhere inside a shell word (path, `--env-file=.env`, code in a -e string).
const NAME_IN_WORD =
  /(?:^|[\\/\s='":(,;])(\.env(?:\.[A-Za-z0-9_.-]+)?|\.dev\.vars(?:\.[A-Za-z0-9_.-]+)?|\.credentials\.json|id_(?:rsa|ed25519|ecdsa|dsa)|[A-Za-z0-9_-][A-Za-z0-9_.-]*\.pem)(?=$|[\s'")\]:;,*?])/gi;

/** @returns {boolean} true when this path/glob string is a credential-bearing file. */
export function isCredentialPath(p) {
  if (typeof p !== "string" || !p) return false;
  const norm = p.replace(/\\/g, "/");
  const base = norm.split("/").pop() ?? "";
  if (EXEMPT.test(base)) return false;
  if (/\.pem$/i.test(base) && PEM_PUBLIC.test(base)) return false;
  const bare = p.replace(/[*?]+$/, ""); // a glob like `.env*`
  return PATH_PATTERNS.some((re) => re.test(p) || re.test(bare));
}

/** @returns {string|null} the credential file name found in a shell word, else null. */
export function credentialInWord(text) {
  NAME_IN_WORD.lastIndex = 0;
  for (const m of String(text).matchAll(NAME_IN_WORD)) {
    const name = m[1];
    if (EXEMPT.test(name)) continue;
    if (/\.pem$/i.test(name) && PEM_PUBLIC.test(name)) continue;
    return name;
  }
  return null;
}

function denyMessage(what) {
  return (
    `BLOCKED (credential-guard): ${what} is a credential-bearing file. Never read it into the model's context. ` +
    "Use the credential-manager skill (OS credential store) for a local command that needs a secret, or ask the owner; " +
    "`.env.example` documents the shape."
  );
}

export function check(ctx) {
  const { tool, input } = ctx;
  if (tool === "Read" || tool === "Grep" || tool === "Glob") {
    for (const v of [input.file_path, input.path, input.glob, input.pattern]) {
      if (typeof v !== "string" || !v) continue;
      // Grep/Glob `pattern` is a content regex / glob: only a glob-looking Glob pattern names files
      if (v === input.pattern && tool !== "Glob") continue;
      if (isCredentialPath(v)) return { deny: denyMessage(v) };
    }
    return undefined;
  }
  for (const seg of ctx.segments()) {
    const words = isDataOnly(seg) ? seg.words.filter((w) => w.redir) : inspectableArgs(seg, { includeRedir: true });
    for (const w of words) {
      const hit = credentialInWord(w.text);
      if (hit) return { deny: denyMessage(hit) };
    }
  }
  return undefined;
}
