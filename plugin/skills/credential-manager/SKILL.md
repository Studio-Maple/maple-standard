---
name: credential-manager
description: Retrieve credentials, API tokens, passwords, and secrets from the OS credential store (Windows Credential Manager) to run local commands (deploy, migration, API call, secret rotation, CI mirror, Wrangler, Supabase CLI, etc.) without ever reading .env or .dev.vars files or asking the user to paste a value. Use this skill whenever a local command needs a secret on Windows — do NOT read credential files or prompt for the value inline.
---

# credential-manager

The OS credential store is the canonical local-secret store under the maple-standard. Every credential, API token, and password used in local commands lives there — DPAPI-encrypted and user-scoped on Windows — and is read just-in-time. This is the approved path; `.env*` and `.dev.vars` are PreToolUse-blocked by `deny-credential-paths.mjs` and must not be read.

The commands below are Windows Credential Manager (the standard's primary platform). On macOS the equivalent store is Keychain (`security find-generic-password -w -s '<Target>'`); on Linux, `secret-tool lookup`. The hard rules at the bottom apply identically on all three.

## When to use / when not

**Use** for any local command that needs a secret: wrangler deploys, Supabase CLI, npx scripts, Docker env injection, custom scripts.

**Do not use** via the Bash tool — Bash cannot reach Credential Manager. PowerShell tool only.

## Prereq

```powershell
Install-Module CredentialManager -Force -Scope CurrentUser
```

## Discover stored credentials (names only, never values)

```powershell
# Lists Target names and types. No passwords are printed.
cmdkey /list
```

## Existence check (boolean only)

```powershell
[bool](Get-StoredCredential -Target '<Project>-<Service>-<Purpose>' -ErrorAction SilentlyContinue)
```

## Retrieve + use without echoing

### Pattern A: process-scope env var (SAFE — prefer this)

In-process assignment crosses no encoding boundary, so the value is delivered exactly.

```powershell
$env:CLOUDFLARE_API_TOKEN = (Get-StoredCredential -Target '<Project>-Cloudflare-API-Token').GetNetworkCredential().Password
# ... run command ...
Remove-Item Env:CLOUDFLARE_API_TOKEN   # explicit cleanup; defense in depth
```

### Pattern B: file-based input (SAFE — for tools that read a value from a file)

For CLIs that accept a secrets file (e.g. `wrangler … secret bulk`), write a temp file as **UTF-8 without BOM** and delete it after. Do NOT pipe (see the gotcha below).

```powershell
$k = (Get-StoredCredential -Target '<Project>-Gemini-API-Key').GetNetworkCredential().Password
$tmp = Join-Path $env:TEMP ([guid]::NewGuid().ToString('N') + '.json')
[System.IO.File]::WriteAllText($tmp, (@{ GEMINI_API_KEY = $k } | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))
npx wrangler pages secret bulk $tmp --project-name=<project>
Remove-Item $tmp -Force
```

### ⚠️ Never PIPE a secret to a native command in PowerShell

`$secret | someExe.exe` is **broken for secrets** on Windows PowerShell 5.1: the pipe prepends a UTF-8 **BOM** and appends **CRLF**, so the consumer receives a corrupted value (a 53-char key arrives as 56 bytes). Many CLIs trim trailing whitespace but NOT a leading BOM — the secret is silently wrong, with no error at set-time. Use Pattern A (env var) or Pattern B (file) instead.

> This cost a real outage once: a piped `wrangler pages secret put` stored a BOM+CRLF-corrupted API key; every call to that upstream returned a friendly "upstream error" until the secret was re-set via `secret bulk` from a UTF-8-no-BOM file. Nothing failed at set-time, so the bad value sat there undetected.

Never use `Write-Output`, `Write-Host`, `echo`, or string interpolation with the plaintext value. Diagnostics: print only booleans or `$value.Length`.

## Store a new credential (owner runs interactively)

Ready-made script (prompts for the value, never echoes it):

```powershell
powershell -ExecutionPolicy Bypass -File "$CLAUDE_PLUGIN_ROOT\skills\credential-manager\scripts\store-secret.ps1" -Target <Project>-<Service>-<Purpose>
```

Or inline, using the SecureString→BSTR pattern. The `-Password` param on `New-StoredCredential` is typed `string` — passing a raw `SecureString` stringifies to the literal `"System.Security.SecureString"`. Always convert first. Pipe to `| Out-Null` — the cmdlet echoes the stored password in plaintext as part of its return object otherwise.

```powershell
function Store-Secret($target) {
  $secure = Read-Host -AsSecureString -Prompt "Paste value for $target"
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    New-StoredCredential -Target $target -UserName dev -Password $plain -Persist LocalMachine | Out-Null
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    Remove-Variable plain -ErrorAction SilentlyContinue
    [GC]::Collect()
  }
  Write-Host "Stored $target." -ForegroundColor Cyan
}

Store-Secret '<Project>-Supabase-PAT'
```

## Hard rules (zero-trust logging)

- Never echo / `Write-Output` / print the plaintext value.
- Never assign it to a variable you later display.
- Plaintext lives in-process only. The SecureString is wiped on process exit.
- `.env*` / `.dev.vars` are PreToolUse-blocked — the credential store is the only sanctioned local path.
- For diagnostics print `$value.Length` or `[bool]($cred)`, never the value.
- Prod deploys / migrations / key rotation: produce the command for the human. They report success only, never values.

## Naming convention

`<Project>-<Service>-<Purpose>`. Casing drifts across entries added at different times — **always match the exact stored target name** from `cmdkey /list` rather than reconstructing it.

Typical entries for a maple-standard project:

| Target name | Used for |
|---|---|
| `<Project>-Supabase-PAT` | `SUPABASE_ACCESS_TOKEN` |
| `<Project>-Supabase-DBPWD` | `SUPABASE_DB_PASSWORD` |
| `<Project>-Cloudflare-API-Token` | `CLOUDFLARE_API_TOKEN` |
| `<Project>-Cloudflare-Account-ID` | `CLOUDFLARE_ACCOUNT_ID` |
| `<Project>-ADMIN-REQUEST-SECRET` | an app-level shared secret |

## Where a project documents its own catalog

A project on this standard should keep its credential catalog and secrets policy in its docs — conventionally `docs/quality/secrets-handling.md` (threat model, failure modes, leak-recovery procedure) — and its Docker/CI env-injection pattern in a local script such as `scripts/local-ci.ps1`. Look for those before asking the owner which target name to use.
