---
type: guide
title: Pre-deploy gate
description: the enforced zero-findings gate in front of every deploy: checks, allowlist, stamp, guard hook, live ZAP policy, emergency override.
tags: [quality, gates, security, deploy]
timestamp: 2026-10-01
audience: anyone about to deploy, configuring the gate for a project, or blocked by the deploy guard
authoritative_for: [the pre-deploy gate's rules, stamp model, live-scan policy, allowlist format and enforcement]
code: [plugin/scripts/predeploy/, plugin/hooks/predeploy-guard.mjs, plugin/commands/predeploy-gate.md, plugin/templates/predeploy-remote.yml]
---
# Pre-deploy gate

D060. The pre-push gate keeps the inner loop fast and Docker-free; it is not
a release signal. The **pre-deploy gate** is: **zero findings from every
scanner we can run, warnings included**, on the exact commit about to ship,
enforced by a hook instead of by discipline. CI minutes are spent only on the
one thing that must run on GitHub.

## Config (`maple.config.json` → `predeploy`)

| Key | Meaning |
|---|---|
| `checks[]` | each `{ id, command \| preset \| github }`. `command` runs locally (non-zero exit = finding, or a `parse` kind). `preset` is a built-in scanner (see below). `github: <workflow>` is remote-only and must carry a written `why`. |
| `allowlist` | committed exceptions file, default `predeploy-allowlist.json` |
| `minSeverity` | per gate / per check floor, default `info` (everything counts) |
| `stampTtlHours`, `allowlistMaxDays` | defaults 72 / 90 |
| `remote` | `{ workflow, ref?, timeoutMin, pollSec }` for the single dispatch workflow |
| `deployGuard.patterns[]` | `{ id, regex }` deploy commands the hook blocks |
| `emergency` | `{ enabled: false, maxMinutes: 60 }` owner-only override |
| `liveScan` | the aggressive post-deploy ZAP scan (below) |

Validation (`validate-config.mjs`) rejects any check command that hides its
own failure (`|| true`, `--exit-zero`, `--no-exit-code`, `--max-warnings=N`,
raised audit/severity floors) and a disabled guard. There are no silent
thresholds: the only exception mechanism is the allowlist.

## Presets

`gitleaks` (tree + full history), `semgrep` (`--disable-nosem`), `osv-scanner`
(every tracked lockfile, dev deps), `npm-audit`, `trivy-fs`, `trivy-image`,
`shellcheck` (style), `actionlint`, `hadolint`, `checkov`, `tflint`,
`terraform` (init/validate/fmt), `deps-freshness`, `supabase-advisors`,
`gh-alerts`, `suppression-audit`. File scanners run on a clean `git archive`
export of the candidate SHA. A tool that is on PATH but does not run (broken
shim, Application Control) falls back to its Docker image; a missing tool is a
`tool-missing` finding, never a skip. `predeploy doctor` prints install
commands.

**Stale** (`deps-freshness`): any deprecated package in a lockfile (direct or
transitive); a direct dependency more than 1 major behind, or not on latest
and published more than 12 months ago. Both numbers are options.

**Suppressions** (`nosemgrep`, `checkov:skip`, `.trivyignore`, `.semgrepignore`,
`osv-scanner.toml`, `gitleaks:allow`, ...) are findings in themselves
(`suppression-audit`) and are disabled where the tool has a flag for it.

## Allowlist

```json
{ "version": 1, "entries": [
  { "check": "semgrep", "id": "rule.id", "location": "optional substring",
    "reason": "why", "owner": "who", "expires": "YYYY-MM-DD" } ] }
```

Expired entries fail the gate; expiry further than `allowlistMaxDays` is
invalid; entries matching nothing fail (`allowlist-unused`); the file must be
committed and unmodified. The guard hook asks the owner before any edit to it.

## Stamp and enforcement

`/predeploy-gate` (`plugin/scripts/predeploy/run.mjs`) runs every check on a
clean tree and writes `<git-common-dir>/maple/predeploy/stamps/<sha>.json`
bound to the sha, a hash of the `predeploy` config and a hash of the allowlist.
`verify.mjs` (exit 0/1) is the check deploy scripts call. The
`predeploy-guard.mjs` PreToolUse hook (Bash, PowerShell, Write, Edit) blocks any
command matching `deployGuard.patterns` unless the stamp verifies (sha, TTL,
config + allowlist hashes, clean tracked tree, no unscanned live deploy), and
blocks tool writes to the stamp directory itself. An unparseable
`maple.config.json` fails closed. Projects also call `verify.mjs` from their
deploy script's preflight (belt and braces).

**Emergency override**: default off. `emergency.mjs --reason "..."` needs an
interactive terminal and the owner typing a phrase naming the sha; grants one
sha for `maxMinutes`, appended to `emergency.log.jsonl`, warned on every use.
There is no flag or env var.

## Remote-only part

One `workflow_dispatch` workflow (template `plugin/templates/predeploy-remote.yml`)
for what needs a clean-room runner. The gate dispatches it for the candidate
sha (which must already be pushed), waits, reuses a prior green run for the
same sha, and the stamp requires `success` for that sha. Alert state that is
only readable from GitHub (code-scanning, Dependabot, secret-scanning) is read
locally with `gh api` (`gh-alerts`) instead of spending minutes. CodeQL needs
GitHub Advanced Security on private repos and its CLI licence forbids local use
there, so it is a `github` check only where GHAS exists; Semgrep covers SAST
locally.

## Live scan policy

An attacker will not be gentle, so neither is the scan. `predeploy.liveScan`
runs ZAP in Docker as a **full active scan with the full attack policy**
(every scanner, strength High, threshold Low, spider + AJAX spider, optional
OpenAPI import) against **every configured live HTTP(S) target**. Zero findings
of any severity unless allowlisted (check id `live-scan`). Exactly two guards,
both configured per project:

1. **No real customer credentials.** Auth is only ever `{ name, credentialRef }`
   headers resolved just-in-time from the OS credential store (scan/service
   tokens); inline secrets and customer-looking refs are rejected.
2. **No PSTN calls.** `callOriginationExcludes` (URL-path regexes) are excluded
   from every target's context; the list must be non-empty or
   `noCallOriginationRoutes: true` must say there are none.

**Stamp model: post-deploy verification that blocks the NEXT deploy.** A live
scan only means something after a deploy, so it cannot gate that deploy. Every
deploy the guard allows is a ledger entry; `predeploy-gate --live` records a
scan with the ledger position it covers; a new stamp (and the guard's
verification) requires a **clean scan covering the latest deploy**. Findings or
no scan = no next deploy. Several steps of the same stamped sha do not owe
debt against their own stamp. Deploy scripts mark failed deploys with
`record-deploy.mjs --outcome failed` so a failed deploy owes no scan. A
target that produced no traffic fails (`target-no-coverage`); an empty report
is not a clean report.

## Commands

```
node plugin/scripts/predeploy/run.mjs [--check ID] [--list] [--json] [--pull]
node plugin/scripts/predeploy/run.mjs --live [--pull]     # after a deploy
node plugin/scripts/predeploy/livescan.mjs --dry-run      # write + print the ZAP plan, send nothing
node plugin/scripts/predeploy/verify.mjs                  # exit 0/1
node plugin/scripts/predeploy/doctor.mjs [--pull]         # missing tools / credentials by name
node plugin/scripts/predeploy/record-deploy.mjs --outcome failed
```
