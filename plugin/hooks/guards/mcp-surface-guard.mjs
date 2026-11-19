// Guard: MCP tools that reach the shell, the file system, the registry or the clipboard (D082, D085).
//
// The built-in shell/file guards only see Bash | PowerShell | Read | Grep | Glob. MCP servers such as
// Windows-MCP (PowerShell, FileSystem, Registry, Clipboard) and the desktop app's terminal
// (run_in_terminal) do the same things under other names, so without this guard a credential-store read or
// `cat .env` through them reaches no guard at all. Always enforced, no warn phase (D082): a warn lets the
// call run, and the secret is then already in the model's context.
//
//   MCP shell (…__PowerShell, …__run_in_terminal)   needs a string `command` (the dispatcher then runs every
//                                                   shell guard on it as PowerShell); anything else is denied
//   …__FileSystem   path / destination / search pattern naming a credential file -> deny
//   …__Registry     get/list under a secret-holding hive (SAM, SECURITY, LSA secrets, credential/vault keys) -> deny
//   …__Clipboard    get -> deny (the clipboard is where a copied password sits; the owner pastes into chat instead)
//   ANY MCP tool     a path-like field or file: URL anywhere in its input (browser navigate/preview/file_upload,
//                    scrapers, batch wrappers that nest whole tool calls) naming a credential file -> deny
//
// Honest limit: input-synthesis tools (Type, Shortcut, App, ...) can type into any window, a terminal included;
// they cannot be judged by their input and are outside this guard.
import { isCredentialPath } from "./deny-credential-paths.mjs";

const MCP_SHELL = /^mcp__.+__(PowerShell|run_in_terminal)$/;
const SECRET_HIVE = /(^|[\\/:])(SAM|SECURITY)([\\/]|$)|Lsa[\\/]+Secrets|Policy[\\/]+Secrets|Protected Storage|\\Credentials?\b|Vault|CredentialManager|Credential Manager/i;

function toolName(ctx) {
  const m = /^mcp__(.+?)__(.+)$/.exec(ctx.rawTool || ctx.tool || "");
  return m ? m[2] : "";
}

// Any MCP tool (browser panes, browser extensions, scrapers, uploaders, batch wrappers) may carry a local path
// or a file: URL in its input, nested at any depth (browser_batch holds whole tool calls). Every path-like field
// and every file: URL is judged like a Read path.
const PATHISH_KEY = /^(path|paths|file|files|file_?path|file_?paths|filename|destination|dest|source|src|target|url|uri|href|location|cwd|dir|directory)$/i;

function asPath(v) {
  if (!/^file:/i.test(v)) return v;
  let p = v.replace(/^file:\/*/i, "").replace(/[?#].*$/, "");
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  return p;
}

/** The first credential-bearing path referenced anywhere in an MCP tool input, else null. */
export function credentialRefIn(value, key = "", depth = 0) {
  if (depth > 12 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (!value || value.length > 4096) return null;
    if (/^file:/i.test(value) || PATHISH_KEY.test(key)) {
      const p = asPath(value);
      if (isCredentialPath(p)) return p;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) { const hit = credentialRefIn(v, key, depth + 1); if (hit) return hit; }
    return null;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { const hit = credentialRefIn(v, k, depth + 1); if (hit) return hit; }
  }
  return null;
}

function credentialDeny(what) {
  return (
    `BLOCKED (mcp-surface-guard): ${what} is a credential-bearing file. MCP file tools follow the same rule as Read: ` +
    "never read it into the model's context. A command that needs a secret runs through the plugin's maple-secret wrapper (D085)."
  );
}

export async function check(ctx) {
  const raw = ctx.rawTool || ctx.tool || "";
  const input = ctx.input ?? {};
  if (MCP_SHELL.test(raw)) {
    if (typeof input.command !== "string" || !input.command.trim()) {
      return { deny: `BLOCKED (mcp-surface-guard): ${raw} called without a string \`command\`; MCP shells are only allowed when the shell guards can read the command.` };
    }
    return undefined;
  }
  const ref = credentialRefIn(input);
  if (ref) return { deny: credentialDeny(ref) };
  const name = toolName(ctx);
  if (name === "FileSystem") {
    for (const v of [input.path, input.destination, input.pattern]) {
      if (typeof v === "string" && v && isCredentialPath(v)) return { deny: credentialDeny(v) };
    }
    if (String(input.mode || "").toLowerCase() === "write" && typeof input.content === "string") {
      // an MCP file write is judged like the Write tool for secrets in what it writes
      const { check: secretWrite } = await import("./secret-write-guard.mjs");
      return secretWrite({ ...ctx, tool: "Write", input: { file_path: input.path, content: input.content } });
    }
    return undefined;
  }
  if (name === "Registry") {
    const mode = String(input.mode || "").toLowerCase();
    if ((mode === "get" || mode === "list") && typeof input.path === "string" && SECRET_HIVE.test(input.path)) {
      return { deny: `BLOCKED (mcp-surface-guard): reading ${input.path} — registry hives that hold secrets (SAM, SECURITY, LSA secrets, credential and vault keys) are never read into the model's context (D085).` };
    }
    return undefined;
  }
  if (name === "Clipboard" && String(input.mode || "").toLowerCase() === "get") {
    return { deny: "BLOCKED (mcp-surface-guard): reading the clipboard — it is where a copied password or token sits. Ask the owner to paste the (non-secret) text into the chat instead (D085)." };
  }
  return undefined;
}

/** An MCP shell whose guards errored or timed out is denied, never allowed (the bypass this guard closes). */
export function failClosed(ctx, why) {
  const raw = ctx.rawTool || "";
  if (MCP_SHELL.test(raw) || /^mcp__.+__(FileSystem|Registry|Clipboard)$/.test(raw)) {
    return { deny: `BLOCKED (mcp-surface-guard): ${why}; an unguarded MCP shell/file call is never allowed.` };
  }
  return undefined;
}
