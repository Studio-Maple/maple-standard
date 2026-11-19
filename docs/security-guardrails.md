---
type: design
title: Security guardrails
description: design for the plugin's security guardrail layer: what already enforces each owner goal, the gaps, controls per stage (edit, commit/push, predeploy, continuous, credentials), rollout via one security config block, overhead budget, and draft decisions awaiting the owner.
tags: [security, design, hooks, supply-chain, secrets]
timestamp: 2026-11-19
audience: owner (approves the drafts), the session that builds phase 2, anyone asking "what stops a vulnerable dependency or a leaked secret?"
authoritative_for: [the security guardrail design, its rollout plan and its open owner decisions]
code: [plugin/hooks/hooks.json, plugin/hooks/guard.mjs, plugin/hooks/scrub-secrets.mjs, plugin/hooks/guards/deny-credential-paths.mjs, plugin/hooks/guards/bash-guard.mjs, plugin/hooks/guards/dep-version-guard.mjs, plugin/scripts/deps/install-guard.mjs, plugin/scripts/deps/registry.mjs, plugin/scripts/predeploy/catalog.mjs, plugin/scripts/predeploy/credentials.mjs, plugin/skills/credential-manager/SKILL.md, plugin/schema/maple.config.schema.json]
---
# Security guardrails

**Status: DESIGN, not built.** Phase 1 of the guardrail layer. Nothing here is
enforced until the owner approves the drafts at the bottom and phase 2 lands
it. The method is the standard's own: enforce by mechanism, low overhead, one
config block, no bypass. The [[predeploy-gate]] already does most of the heavy
lifting, so most of this design closes the gaps around it.

## Owner goals → what enforces them today → gap

| Goal | Already enforced | Real gap |
|---|---|---|
| Dependencies are reliable | D064: `dep-version-guard` (no hand-written versions), `bash-guard` install-guard (pinned add behind latest major / inside cooldown), `check-dep-freshness` (fast tier), pnpm `minimumReleaseAge`, predeploy `deps-freshness` (deprecated / stale) | No popularity / typosquat / age check on a **new** package name; bare `pnpm add foo` is not looked up at all; no pip / uv coverage |
| Deployed version has no known CVEs | Predeploy gate (D060/D061/D063): `osv-scanner`, `npm-audit`, `trivy-fs`, `trivy-image` (own + third-party refs), `snyk`, zero findings, expiring allowlist (owner + expires, 90-day cap), `suppression-audit` flags `.trivyignore` / `osv-scanner.toml` | CVEs published **after** the deploy are seen only on the next predeploy run: nothing re-scans what is live on a schedule |
| A dependency added while coding is not vulnerable | Nothing at edit time (only freshness) | OSV lookup at add time; the first vulnerability signal is today the predeploy gate, days later |
| localhost never in prod | Nothing | Edit-time guard on prod config + a predeploy preset + a live CORS probe |
| Credentials never leak | `deny-credential-paths` (Read/Grep/Glob + any shell verb naming a credential file), `scrub-secrets` PostToolUse (known token shapes), predeploy `gitleaks` (tree + history) | No scan of what Claude **writes** (Write/Edit); no gitleaks at commit (template's pre-commit has none, Caller's is project-local); scrubber only knows token shapes, not arbitrary passwords |
| Claude can never read Credential Manager values | Nothing. The credential-manager skill *tells* Claude to run `Get-StoredCredential … .Password` itself | **Two holes**, below |

### Headline findings

1. **MCP shell tools bypass every guard.** `hooks.json` matches `Bash|PowerShell|Read|Grep|Glob|Write|Edit|MultiEdit` plus named Supabase MCP tools. Sessions also carry `mcp__Windows-MCP__PowerShell`, `mcp__terminal__run_in_terminal`, `mcp__Windows-MCP__FileSystem`, `…__Registry`, `…__Clipboard`. A `Get-StoredCredential` or `cat .env` through any of them never reaches `guard.mjs`, and their output never reaches `scrub-secrets`. Every "never" in this page is false until that is closed.
2. **The credential rule is trust-based.** The skill's Pattern A runs the retrieval in Claude's own shell, so one stray `Write-Output` (or a non-token-shaped value the scrubber does not know) lands the secret in context. Patterns cannot fix this; only a wrapper that holds the value can (Credentials, below).

Exceptions channel: the predeploy allowlist (`{check, id, location, reason, owner, expires}`) is already the one place a time-boxed CVE exception lives (the Maple-Pole picomatch case fits it as-is); `suppression-audit` already flags tool-native ignore files. This design adds **no** second exception file.

## Controls by stage

New guard modules plug into the existing D065 dispatcher (`guard.mjs`, one process per event, lazy imports). No new hook processes.

### 1. Edit time (Claude Code hooks)

**E0. Close the MCP bypass (quick win).**
- Extend the PreToolUse matcher with the shell-capable and file-capable MCP tools: `mcp__.*__(PowerShell|run_in_terminal|FileSystem|Registry|Clipboard)` (exact list confirmed against the installed servers in phase 2).
- `guard.mjs` maps them: shell tools → the full `SHELL_GUARDS` plan with `command` read from the tool's input field; FileSystem read → `deny-credential-paths`; Registry reads under credential hives and Clipboard *get* → deny.
- Same matcher on the PostToolUse `scrub-secrets` entry.
- Fallback rule: an MCP tool whose input cannot be parsed into a command/path is denied, not allowed (fail closed for this one class).

**E1. Package-add guard** (extends `install-guard`, `security.packageAdd`).
- Triggers: `pnpm|npm|yarn|bun add|install <name>`, `pip|uv pip install <name>`, `uv add`, `poetry add`. Edits to `requirements*.txt` / `pyproject.toml` get the same treatment as D064's package.json edit check.
- Per package (in parallel, one batched OSV `querybatch` call):
  - **Release age**: resolved version older than `minReleaseAgeDays` (Draft-A). npm reuses `registry.mjs`; PyPI uses the JSON API `upload_time`.
  - **OSV**: no known vuln in the resolved version (`api.osv.dev/v1/querybatch`, ecosystems npm / PyPI). Severity floor: any (Draft-B).
  - **Reputation (new names only, not already in the lockfile)**: weekly downloads ≥ `minWeeklyDownloads`, package age ≥ 30 days, not deprecated, not within edit distance 1-2 of a name in a bundled top-N list (typosquat) unless it *is* that name. npm downloads API / pypistats.
  - **Pinned version**: the add must land an exact or lockfile-pinned version (npm/pnpm do via lockfile; pip must use `==` or a hashed requirements file, uv lock).
- Bare names now ARE looked up (today they pass without a lookup).
- Fail-open on network error with a warning (as D064 today); the commit/push OSV check is the backstop.
- Exceptions: `deps.exceptions[]` (D###-backed, existing).

**E2. Secret scan on Write/Edit** (`security.secretWrite`).
- New guard on Write/Edit/MultiEdit/NotebookEdit: run the **same pattern catalog** as `scrub-secrets` (extracted into one shared module, so there is never a second regex list) over the *new* text only (after − before).
- Plus high-entropy assignment heuristic (`(secret|token|key|password)\s*[:=]\s*"<24+ chars, entropy > 4>"`), warn-only.
- Exempt: `.env.example` with obvious placeholders, test fixtures under declared paths.

**E3. Secret-exposing shell guard** (`security.secretShell`, always enforce).
- Deny: printing secret-named env vars (`echo $X`, `$env:X`, `Write-Output $env:X`, `printenv X` where X matches `/TOKEN|SECRET|KEY|PASSWORD|PASS|PAT|CRED|AUTH/i`); bare `env` / `printenv` / `set` / `Get-ChildItem env:` / `dir env:` dumps; `cat`/`type` of `~/.aws/credentials`, `~/.npmrc` etc. (extends the shell path list to match the Read list); `git config --get` of credential helpers' stores; `gh auth token`, `vercel whoami --token`-style token prints.
- Reading `.env*` in any form is already denied (`deny-credential-paths`).

**E4. Prod-config localhost guard** (`security.localhost`).
- Scope: files declared prod in `security.localhost.prodFiles` (defaults: `.env.production*`, `wrangler.toml` / `wrangler.jsonc` `[env.production]` sections, `vercel.json`, `fly.toml`, `railway.json`, `*.prod.*` compose files, `infra/**/*.tf`, `next.config.*` `headers()` CSP block). `supabase/config.toml` is **local dev** config and is excluded.
- On Write/Edit, new text containing `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`, `*.local`, `host.docker.internal` in a CORS origin, redirect URL, allowlist, CSP source or URL value → deny (enforce) / warn.
- Source files (CORS arrays in code) → warn only, since dev branches gated on `NODE_ENV` are legitimate; the predeploy preset is the hard stop.

### 2. Commit and push (git hooks, `security.gitHooks`)

Installed by the existing `install-hooks.mjs` path (absolute hooksPath, fail closed). The template's `ci-local.sh` has **no** gitleaks or supply-chain step today (the names exist only in the light-step regex; Caller defines its own).

- **pre-commit: `gitleaks protect --staged --redact`** (~0.1-0.3 s). Missing gitleaks = fail with the install command, never a skip.
- **pre-push, only when a lockfile / manifest changed** (affected-only, like D066):
  - `osv-scanner scan source -L <changed lockfiles>` against a locally cached DB (`--offline` with a daily refresh), empty config file so `osv-scanner.toml` is not honoured.
  - **Lockfile integrity**: lockfile in sync with manifests (`pnpm install --frozen-lockfile --lockfile-only` / `npm ci --dry-run`), every resolved URL on the configured registry over https (no git / http / tarball URLs unless excepted), every entry carries an `integrity` hash, registry host unchanged. Lift Caller's `lock-closure` and `npm-signatures` (`npm audit signatures`) into plugin presets instead of rewriting them.

### 3. Predeploy gate (exists; tighten)

- With `security` on, the gate **requires** these presets to be present in `predeploy.checks` (validate-config error otherwise): `gitleaks`, `osv-scanner`, `trivy-fs`, `trivy-image` for every deployed image, `suppression-audit`, and the new `prod-localhost`.
- **New preset `prod-localhost`**: scans the candidate's prod config files (same list as E4) and the built artifact's emitted config for loopback hosts; plus a Supabase auth-config read (site URL + redirect allowlist via the management API, token through the credential wrapper) for projects with `supabase.prodProjectRefs`.
- **Live CORS probe** in `liveScan`: request each live origin with `Origin: http://localhost:3000`; a reflected `Access-Control-Allow-Origin` or `*` with credentials is a finding.
- Exceptions: unchanged (allowlist with owner + expires; decision-backed list). Zero unexcepted CVEs is already the rule.

### 4. Continuous

- **Weekly live re-scan** (`security.continuous.weekly`): re-run the vulnerability presets (`osv-scanner`, `npm-audit`, `trivy-image` by deployed ref) against the **deployed sha** from the deploy ledger, with a fresh DB. A new finding opens a task on the app's MapleLens board (or `docs/gaps.md` outside MapleLens) and blocks the next stamp. Runs on the **local desk / MapleLens scheduler**, not GitHub Actions: `gaps.md` already says CI only deploys, and Caller's Actions are billing-blocked.
- **Dependency bot with cooldown**: Dependabot `cooldown: { default-days: N }`, weekly, security updates ungrouped from cooldown. The template is monthly with no cooldown; Caller is weekly with 7 days. Standardize (Draft-A). Renovate is the alternative (`minimumReleaseAge`), not proposed: Dependabot is already wired with automerge.
- Package manager cooldown matches: pnpm `minimumReleaseAge`, npm `min-release-age`, uv `exclude-newer` (relative), all at the same N days.

### 5. Credentials: Claude never reads Credential Manager

Rule: a secret flows store → child process env (or a temp file) → the command. It never passes through a shell Claude reads, never prints, never lands in context.

**Mechanism: a plugin wrapper that holds the value, plus a guard that denies every other retrieval path.**

- **`maple-secret run`** (`plugin/scripts/secrets/`, node, reusing `predeploy/credentials.mjs`):
  `node maple-secret.mjs run --env CLOUDFLARE_API_TOKEN=<Target> [--file NAME=<Target>] -- <command…>`
  - Reads each target from Credential Manager (or `MAPLE_CRED_*` in CI), sets it in the **child's** env only (or writes a UTF-8-no-BOM temp file, deleted in `finally`, path passed as `{file:NAME}` in argv).
  - Pipes the child's stdout/stderr through an **exact-value redactor** that knows the value (plus its base64, URL-encoded and JSON-escaped forms), so even a CLI that echoes its token prints `[REDACTED:<Target>]`.
  - Exit code passes through. Never writes the value to argv, a log, or a report.
  - `exists <Target>` / `list`: names and booleans only (wraps `cmdkey /list`).
- **Guard `credential-store-guard`** (all shell tools incl. MCP, always enforce, no warn phase): deny any command that reaches the store directly: `Get-StoredCredential`, `GetNetworkCredential`, `.Password` on a credential object, `CredRead` / `CredEnumerate` P/Invoke, `Windows.Security.Credentials.PasswordVault`, `vaultcmd /listcreds`, `PtrToStringBSTR`/`PtrToStringAuto` on a SecureString, `security find-generic-password -w`, `secret-tool lookup`, importing `credentials.mjs` / calling `getCredential` outside the gate and wrapper entry points. Allow: `cmdkey /list`, `maple-secret run|exists|list`, the predeploy runner, the owner-only `store-secret.ps1` (interactive prompt; non-interactive Claude cannot feed it).
- **Write-side**: E2's Write/Edit guard also denies writing a script outside `plugin/` that contains those store APIs (so the guard cannot be sidestepped by writing a `.ps1` and running it).
- **Skill rewrite**: credential-manager's Patterns A/B become "call `maple-secret run`"; the in-shell retrieval patterns are removed from the skill.
- **Honest limits**: a deliberately adversarial agent could still transform the value in the child (e.g. reverse it) before printing; the redactor covers the common encodings, not arbitrary transforms. The design stops accidental leakage and casual exfiltration, and denies every direct store path; it is not a sandbox. Screenshot/Snapshot MCP tools cannot be filtered and never show stored values unless a window displays them.

## Rollout

### One config block

```jsonc
// maple.config.json
"security": {
  "mode": "warn",                 // warn | enforce
  "enforceAfter": "2026-11-26",   // the hook flips itself to enforce on this date: mechanism, not memory
  "controls": {                   // every control on by default; per-control override to off|warn|enforce
    "packageAdd":  { "minReleaseAgeDays": 7, "minWeeklyDownloads": 1000, "osv": true },
    "secretWrite": {},
    "localhost":   { "prodFiles": [] },   // extra globs on top of the defaults
    "gitHooks":    {},
    "continuous":  { "weekly": true }
    // secretShell and credentialStore are not listed: always enforce, not configurable
  }
}
```

- Absent block = all controls in warn mode (Draft-D), so a plugin bump alone already reports.
- **Warn mode** = allow + `additionalContext` + one line appended to `<git-common-dir>/maple/security-log.jsonl` (control, rule, file/command shape, never values). `/project-status` shows the would-be denial count, so the flip to enforce is decided on data.
- **Never warn-only**: `credentialStore`, `secretShell`, E0 (MCP bypass). A PreToolUse warn lets the command run, and then the secret is already in context. These enforce from day one; the explicit exception to warn-then-enforce.
- Schema in `maple.config.schema.json`; `validate-config.mjs` rejects `mode: "off"` for the always-enforce controls and an `enforceAfter` more than 30 days out.

### Per project

- **New projects**: `/adopt-standard` writes the block with `enforceAfter` = today + 7, installs gitleaks / osv-scanner check via `predeploy doctor`, adds the Dependabot cooldown and package-manager cooldown.
- **Existing projects** (VeHagita, EasyCaller, Maple-Pole, Nekuda, MapleLens, SmartMatzeva): plugin bump (SessionStart cache sync, D053) + one line `"security": { "enforceAfter": "<date>" }`. Order: pilot on one project in warn (Draft-E), then the rest a week apart, so each project's warn log is reviewed before its flip.
- Caller already runs most predeploy presets and has its own pre-commit gitleaks: the plugin's hook checks for an existing equivalent step and does not double-run.

## Overhead budget

| Control | Runs on | Cold | Warm (cached) |
|---|---|---|---|
| E0 MCP routing | every matched MCP call | +0 (same dispatcher process, ~60-100 ms already paid) | same |
| E1 package-add | install commands only | 1-2 s (registry + OSV batch + downloads, in parallel, 4 s cap) | < 10 ms |
| E2 secret write | Write/Edit | < 5 ms (regex over the diff) | same |
| E3 / credential-store | shell calls | < 2 ms (token scan, already parsed) | same |
| E4 localhost | Write/Edit of prod files | < 5 ms | same |
| pre-commit gitleaks | commit | 0.1-0.3 s | same |
| pre-push OSV + lockfile | push, only if a lockfile changed | 1-3 s | same |
| weekly re-scan | scheduled | minutes, off the critical path | — |

**Cache**: `~/.cache/maple/security/` (user-level, shared by all projects and worktrees): registry metadata and download counts 24 h, OSV results per `ecosystem/name@version` 6 h, OSV offline DB refreshed daily, the typosquat top-N list shipped with the plugin. Never stores secrets.

## Phase 2 quick wins (in order)

1. **E0**: MCP shell/file tools through the guards (closes the biggest hole; hours).
2. **Credentials**: `maple-secret run` + `credential-store-guard` + skill rewrite.
3. **E3** secret-printing shell guard, **E2** Write/Edit secret scan on the shared catalog, pre-commit `gitleaks protect --staged`.
4. **E1** package-add: bare-name lookup, OSV, reputation/typosquat, cache; then pip/uv.
5. Cooldown standardization (Dependabot `cooldown`, package managers).
6. Later: E4 + `prod-localhost` preset + live CORS probe, lockfile integrity presets (lifted from Caller), weekly re-scan.

Each lands with unit tests in `plugin/scripts/hooks/` fixtures, a plugin version bump, a CHANGELOG entry, then a warn-mode pilot.

## Draft decisions for the owner

Not logged; IDs get allocated when approved.

- **Draft-A, release cooldown: 7 days everywhere.** Package-manager cooldown (pnpm `minimumReleaseAge: 10080`, npm `min-release-age=7`, uv `exclude-newer`), the add-time guard, and Dependabot `cooldown.default-days: 7`, weekly. Template today: 1 day, monthly bot, no cooldown; Caller: 7 days. Security updates bypass the bot cooldown but not the add-time OSV check. Alternative: 3 days (faster fixes, less supply-chain margin).
- **Draft-B, add-time thresholds.** Deny on any OSV vuln in the resolved version (all severities, matching the gate's zero rule); new-package reputation: ≥ 1,000 weekly downloads, ≥ 30 days old, not deprecated, typosquat edit distance ≤ 2 vs top 5,000 names → deny; owner-approved `deps.exceptions` override. Alternative: reputation as warn-only.
- **Draft-C, tools.** Secrets: **gitleaks** (already in the gate and Caller; fast; local) over trufflehog (verifies live, slower, network) and detect-secrets (Python dependency). Vulns: **OSV** (free, no token, offline DB, npm + PyPI) as the edit/push source; **Socket** not adopted now (token, paid tiers for full API, network on every add) but its free reputation signal is a later option if typosquats slip through. Bot: **Dependabot** with `cooldown`, not Renovate.
- **Draft-D, warn → enforce.** Absent `security` block = warn; each project flips to enforce automatically at `enforceAfter` (≤ 30 days, default 7 after adoption). Credential store, secret printing and the MCP bypass enforce from day one with no warn phase.
- **Draft-E, pilot project.** Pilot in warn mode on **MapleLens** (active dev, no live customers, already the control surface), then EasyCaller, VeHagita, Maple-Pole, Nekuda, SmartMatzeva a week apart. Alternative: EasyCaller first (most security debt, most to learn, more noise).
- **Draft-F, weekly live re-scan runs locally** (desk / MapleLens scheduler) against the deployed sha; a new CVE opens a board task and blocks the next stamp, it does not page or auto-rollback.
- **Draft-G, credential wrapper is the only retrieval path.** Direct `Get-StoredCredential`-style retrieval is denied in every shell tool, including the owner's own sessions run through Claude; the owner keeps the store UI and `store-secret.ps1`.

## Related

[[predeploy-gate]] · [[quality]] · [[standard-architecture]] · [[decisions]] (D060, D061, D063, D064, D065, D070)
