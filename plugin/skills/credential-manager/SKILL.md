---
name: credential-manager
description: Use a stored credential, API token, password or secret (Windows Credential Manager) for a local command (deploy, migration, API call, secret rotation, CI mirror, Wrangler, Supabase CLI, etc.) through the maple-secret wrapper, without ever reading .env or .dev.vars files, retrieving the value yourself, or asking the user to paste it. Use this skill whenever a local command needs a secret on Windows.
---

# credential-manager

The OS credential store is the canonical local-secret store under the maple-standard (DPAPI-encrypted, user-scoped on Windows). **The `maple-secret` wrapper is the only retrieval path (D085).** It reads the value just-in-time, puts it in the child process only, and redacts it from the child's output. Every direct retrieval (`Get-StoredCredential`, `GetNetworkCredential`, `.Password`, `CredRead`, `PasswordVault`, `vaultcmd`, `Marshal.PtrToString*`, `ConvertFrom-SecureString -AsPlainText`, `security find-generic-password -w`, `secret-tool lookup`, importing `credentials.mjs`) is denied by the `credential-store-guard` hook in every shell tool, including MCP shells. `.env*` and `.dev.vars` are blocked by `deny-credential-paths.mjs`. Do not try to work around either: use the wrapper.

## Run a command with a secret

`maple-secret run` reads each target, sets it in the child's environment only, runs the command, redacts the value (and its base64, base64url, URL-encoded and JSON-escaped forms) from stdout/stderr as `[REDACTED:<Target>]`, and passes the exit code through. A missing target exits 2 and names the target only.

### Pattern A: environment variable (prefer this)

PowerShell:

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/secrets/maple-secret.mjs" run --env CLOUDFLARE_API_TOKEN=<Project>-Cloudflare-API-Token --env CLOUDFLARE_ACCOUNT_ID=<Project>-Cloudflare-Account-ID -- npx wrangler pages deploy dist
```

Bash:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/secrets/maple-secret.mjs" run --env CLOUDFLARE_API_TOKEN=<Project>-Cloudflare-API-Token -- npx wrangler pages deploy dist
```

`--env NAME=<Target>` is repeatable. The variable exists only in the child; nothing is left in your shell to clean up.

### Pattern B: file input (for tools that read a value from a file)

`--file NAME=<Target>` writes the value to a fresh temp file (UTF-8 **without BOM**, mode 0600), passes the file's **path** in env var `NAME`, and deletes the file when the command ends (also on Ctrl+C or failure).

PowerShell:

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/secrets/maple-secret.mjs" run --file GEMINI_KEY_FILE=<Project>-Gemini-API-Key -- node scripts/upload-key.mjs
```

Bash:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/secrets/maple-secret.mjs" run --file GEMINI_KEY_FILE=<Project>-Gemini-API-Key -- node scripts/upload-key.mjs
```

The command reads the path from `$GEMINI_KEY_FILE` (for example `process.env.GEMINI_KEY_FILE`). A tool that wants the value as a JSON secrets file needs a small script of its own that reads the file at that path and builds the shape it needs. Do not build it in your own shell from a retrieved value.

### Pattern C: CLIs that read the secret on stdin

`docker login --password-stdin`, `wrangler secret put`, `gh secret set` and similar read the value from stdin. Pipe it INSIDE the child, where the wrapper holds it; never `echo $X | cli` in your own shell (the secret-shell-guard denies it):

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/secrets/maple-secret.mjs" run --env P=<Project>-Docker-Registry-Token -- \
  bash -c 'printf %s "$P" | docker login ghcr.io -u <user> --password-stdin'
```

`printf %s` adds no newline (and bash adds no BOM); in PowerShell prefer Pattern B over a pipe, for the BOM reason below.

### Why the wrapper writes no-BOM files (background)

Piping a secret to a native command in Windows PowerShell 5.1 (`$secret | someExe.exe`) prepends a UTF-8 **BOM** and appends **CRLF**, so the consumer receives a corrupted value (a 53-char key arrives as 56 bytes). Many CLIs trim trailing whitespace but not a leading BOM, so the secret is silently wrong with no error at set-time. This once caused a real outage (a piped `wrangler pages secret put` stored a corrupted API key and every call to that upstream failed quietly). The wrapper avoids it by construction: env vars cross no encoding boundary, and temp files are written as raw UTF-8 bytes with no BOM and no newline. Never pipe a secret into a native command.

## Discover stored credentials (names only, never values)

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/secrets/maple-secret.mjs" list
```

(`cmdkey /list` is also allowed. Neither prints a value.) Always match the exact stored target name rather than reconstructing it.

## Existence check (boolean only)

```powershell
node "$env:CLAUDE_PLUGIN_ROOT/scripts/secrets/maple-secret.mjs" exists <Project>-<Service>-<Purpose>
```

Prints `true` or `false`. Use it before a deploy so a missing credential is reported by name.

## Store a new credential (owner only, interactive)

The owner stores values; Claude never does, and the guard denies `cmdkey /generic ... /pass` and `New-StoredCredential`-style writes from an agent shell. The owner runs the interactive script, which prompts for the value, never echoes it, and writes through Win32 `CredWriteW` (up to 2560 bytes):

```powershell
powershell -ExecutionPolicy Bypass -File "$CLAUDE_PLUGIN_ROOT\skills\credential-manager\scripts\store-secret.ps1" -Target <Project>-<Service>-<Purpose>
```

A non-interactive agent cannot feed it a value. If a credential is missing, tell the owner the target name and ask them to run it.

## Hard rules (zero-trust logging)

- `maple-secret` is the only retrieval path (D085). Never retrieve, print, assign, log or interpolate a plaintext value yourself.
- Never put a secret in argv, a file you write, a report or a commit. Diagnostics: print booleans (`exists`), never values or lengths of values.
- Wrapper redaction covers the exact value and its common encodings, not arbitrary transforms by the child. Do not run a command that deliberately re-encodes or prints the secret.
- Prod deploys / migrations / key rotation: produce the command for the human. They report success only, never values.
- `.env*` / `.dev.vars` are PreToolUse-blocked; the credential store via the wrapper is the only sanctioned local path.
- macOS Keychain and Linux `secret-tool` are not wrapped yet; on those platforms only the `MAPLE_CRED_<TARGET>` environment fallback works (CI).

## Naming convention

`<Project>-<Service>-<Purpose>`. Casing drifts across entries added at different times, so **always match the exact stored target name** from `maple-secret list`. The env fallback name is `MAPLE_CRED_` plus the target upper-snake-cased (CI and tests only).

Typical entries for a maple-standard project:

| Target name | Used for |
|---|---|
| `<Project>-Supabase-PAT` | `SUPABASE_ACCESS_TOKEN` |
| `<Project>-Supabase-DBPWD` | `SUPABASE_DB_PASSWORD` |
| `<Project>-Cloudflare-API-Token` | `CLOUDFLARE_API_TOKEN` |
| `<Project>-Cloudflare-Account-ID` | `CLOUDFLARE_ACCOUNT_ID` |
| `<Project>-ADMIN-REQUEST-SECRET` | an app-level shared secret |

## Where a project documents its own catalog

A project on this standard should keep its credential catalog and secrets policy in its docs, conventionally `docs/quality/secrets-handling.md` (threat model, failure modes, leak-recovery procedure), and its Docker/CI env-injection pattern in a local script such as `scripts/local-ci.ps1`. Look for those before asking the owner which target name to use.
