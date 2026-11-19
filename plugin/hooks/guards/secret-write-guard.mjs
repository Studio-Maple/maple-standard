// Guard: secrets in text an agent WRITES (Write | Edit | MultiEdit | NotebookEdit). Control "secretWrite"
// (warn first, then enforce, D082), plus one always-enforced rule for the credential store (D085).
//
// 1. Catalog hit (secret-patterns.mjs, the same list scrub-secrets redacts with): the NEW text carries a
//    secret-shaped value that the old text did not -> deny. Only what the edit adds counts, so editing a file
//    that already holds one is not blamed on this edit (gitleaks at commit catches what is already there).
// 2. High-entropy literal assigned to a secret-looking key (`apiKey: "…"`): warn only, never deny (heuristic).
// 3. Always enforced (credentialStore, D085): a script file outside the plugin's own secret helpers that calls
//    the credential store directly (Get-StoredCredential, GetNetworkCredential, CredRead, PasswordVault, ...).
//    Without this, the shell guard could be sidestepped by writing a .ps1 and running it.
//
// Options: security.controls.secretWrite.allowPaths: ["glob", ...] (forward-slash, relative to the repo root).
import { existsSync, readFileSync, statSync } from "node:fs";
import { relative } from "node:path";
import { secretKinds } from "../secret-patterns.mjs";
import { applyMode, controlOptions } from "./security-mode.mjs";

const SCRIPT_EXT = /\.(ps1|psm1|psd1|mjs|cjs|js|ts|mts|cts|py|sh|bash|zsh|cmd|bat|rb|go|cs)$/i;
const STORE_API = /Get-StoredCredential|GetNetworkCredential\s*\(|\bCredRead[AW]?\b|\bCredEnumerate[AW]?\b|PasswordVault|PtrToString(BSTR|Auto|Uni)|SecureStringToBSTR|find-generic-password|secret-tool\s+lookup/i;
// The plugin's own secret helpers, guards and their tests name these APIs on purpose.
const STORE_HELPERS = /(^|\/)plugin\/(scripts\/(secrets|predeploy|hooks)\/|hooks\/|skills\/credential-manager\/)/i;
const ENTROPY_ASSIGN = /\b([A-Za-z_]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z_]*)["']?\s*[:=]\s*["'`]([A-Za-z0-9+/=_\-.]{24,})["'`]/gi;
const PLACEHOLDER = /^(x+|0+|your[-_]|example|changeme|placeholder|dummy|test|fake|sample|redacted|<|\$\{|process\.env)/i;

/** A Write over an existing file replaces it: what is already there is not this edit's doing. */
function currentContent(file) {
  try {
    if (typeof file !== "string" || !file || !existsSync(file)) return "";
    if (statSync(file).size > 2_000_000) return "";
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** The text this call adds, and the text it replaces (empty for a new file). */
export function addedText(tool, input) {
  if (tool === "Write") return { added: String(input.content ?? ""), removed: currentContent(input.file_path) };
  if (tool === "Edit") return { added: String(input.new_string ?? ""), removed: String(input.old_string ?? "") };
  if (tool === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    return { added: edits.map((e) => String(e?.new_string ?? "")).join("\n"), removed: edits.map((e) => String(e?.old_string ?? "")).join("\n") };
  }
  if (tool === "NotebookEdit") return { added: String(input.new_source ?? ""), removed: "" };
  return { added: "", removed: "" };
}

function entropy(s) {
  const freq = {};
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1;
  let h = 0;
  for (const n of Object.values(freq)) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/** Keys whose quoted literal looks like a real high-entropy secret. */
export function entropyHits(text) {
  const hits = [];
  ENTROPY_ASSIGN.lastIndex = 0;
  for (const m of String(text).matchAll(ENTROPY_ASSIGN)) {
    const v = m[2];
    if (PLACEHOLDER.test(v) || /(.)\1{5,}/.test(v)) continue;
    if (entropy(v) > 4.0) hits.push(m[1]);
  }
  return hits;
}

function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${esc}$`, "i");
}

export function check(ctx) {
  const file = String(ctx.input?.file_path ?? ctx.input?.notebook_path ?? "").replace(/\\/g, "/");
  const { added, removed } = addedText(ctx.tool, ctx.input ?? {});
  if (!added) return undefined;

  // 3. credential store calls in a script (always enforced)
  if (SCRIPT_EXT.test(file) && !STORE_HELPERS.test(file) && STORE_API.test(added) && !STORE_API.test(removed)) {
    return {
      deny:
        `BLOCKED (secret-write-guard, D085): ${file} would call the credential store directly (${STORE_API.exec(added)[0]}). ` +
        "Scripts never fetch secrets themselves: run them through `node \"$CLAUDE_PLUGIN_ROOT/scripts/secrets/maple-secret.mjs\" run --env NAME=<Target> -- <command>` and read process.env.NAME.",
    };
  }

  const { root } = ctx.config();
  const rel = root ? relative(root, file).replace(/\\/g, "/") : file;
  const allow = controlOptions(ctx.config().cfg, "secretWrite").allowPaths;
  if (Array.isArray(allow) && allow.some((g) => typeof g === "string" && globToRe(g).test(rel))) return undefined;

  // 1. catalog
  const before = new Set(secretKinds(removed));
  const kinds = secretKinds(added).filter((k) => !before.has(k));
  if (kinds.length) {
    return applyMode(ctx, "secretWrite", {
      deny:
        `BLOCKED (secret-write-guard): the text written to ${rel || "this file"} contains a secret-shaped value (${kinds.join(", ")}). ` +
        "Secrets never go into files an agent writes: reference them from the environment (process.env.X / Deno.env.get) and keep the value in the OS credential store or the platform's secret store. " +
        "A synthetic test value should be assembled at runtime so it is not secret-shaped in source.",
    }, { rule: `catalog:${kinds[0]}`, subject: rel });
  }

  // 2. heuristic (warn only)
  const ent = entropyHits(added).filter((k) => !entropyHits(removed).includes(k));
  if (ent.length) {
    return { warn: `secret-write-guard: ${rel || "this file"} assigns a high-entropy literal to ${ent[0]} — if that is a real secret, move it to the environment / secret store instead.` };
  }
  return undefined;
}
