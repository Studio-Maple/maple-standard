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
| `allowlist` | committed, **expiring** exceptions file, default `predeploy-allowlist.json` |
| `decisions`, `decisionsMaxAgeDays` | committed **permanent** decision-backed exceptions file, default `predeploy-decisions.json`; max review age 1..365 days, default 180 (D061) |
| `minSeverity` | per gate / per check floor, default `info` (everything counts) |
| `stampTtlHours`, `allowlistMaxDays` | defaults 72 / 90 |
| `remote` | `{ workflow, ref?, timeoutMin, pollSec }` for the single dispatch workflow |
| `deployGuard.patterns[]` | `{ id, regex }` deploy commands the hook blocks |
| `emergency` | `{ enabled: false, maxMinutes: 60 }` owner-only override |
| `liveScan` | the aggressive post-deploy ZAP scan (below) |

Validation (`validate-config.mjs`) rejects any check command that hides its
own failure (`|| true`, `--exit-zero`, `--no-exit-code`, `--max-warnings=N`,
raised audit/severity floors) and a disabled guard. There are no silent
thresholds: exceptions live in exactly two files, the expiring allowlist and the decision-backed list below.

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

**Images** (`trivy-image`): `options.images` entries are either `{ name, context, ... }` (built
from the candidate tree) or `{ name, ref, platform? }` — a THIRD-PARTY image run as-is, pulled by the exact
ref that is deployed (tag or digest) and scanned for vulnerabilities and secrets. Every image that runs in
production must be listed, ours or not: an unscanned image is a hole, not a zero. `ref` and `context` are
mutually exclusive; an unpullable ref is an `image-pull-failed` finding. Pulled images are removed afterwards
only if they were not already present. Findings carry `name: target` as location and `pkg@version` as resource.

**Stale** (`deps-freshness`): any deprecated package in a lockfile (direct or
transitive); a direct dependency more than 1 major behind, or not on latest
and published more than 12 months ago. Both numbers are options.

**Suppressions** (`nosemgrep`, `checkov:skip`, `eslint-disable`, `.trivyignore`,
`.semgrepignore`, `.snyk`, `osv-scanner.toml`, `gitleaks:allow`, a `.gitleaks.toml`
with an allowlist, a knip config with `ignore*` keys, ...) are findings in
themselves (`suppression-audit`). Policy (D061): **flagged, not mirrored.** A
suppression survives only if it is removed (preferred), or backed by a
decision-backed entry with `scanner: "suppression-audit"`, `rule:
"suppression-file:<name>"` / `"suppression:<marker>"` and the exact file as
`scope`. Where a tool has a flag the gate also disables it (semgrep
`--disable-nosem`, gitleaks `--ignore-gitleaks-allow`, trivy/osv empty ignore
files), and the scan copy never contains `.checkov.yaml`/`.checkov.baseline`,
`.semgrepignore`, `.trivyignore`, `trivy.yaml`, `.hadolint.yaml` or
`.shellcheckrc` (checkov, for one, loads `.checkov.yaml` even next to
`--config-file`). Two honest limits: the project's gitleaks config is still
honoured for its custom rules (only its allowlist blocks are flagged), and an
eslint flat-config `ignores:` array is not detected (config is code); `eslint-disable`
comments and `.eslintignore` are.

## Allowlist

```json
{ "version": 1, "entries": [
  { "check": "semgrep", "id": "rule.id", "location": "optional substring",
    "reason": "why", "owner": "who", "expires": "YYYY-MM-DD" } ] }
```

Expired entries fail the gate; expiry further than `allowlistMaxDays` is
invalid; entries matching nothing fail (`allowlist-unused`); the file must be
committed and unmodified. The guard hook asks the owner before any edit to it.

## Decision-backed exceptions (permanent, essentials only)

The allowlist stays empty by design. The few findings that can never be fixed
(a KMS key policy's root `kms:*` statement, data residency vs. replication, a
carrier allow-listed public IP, a scanner false positive) live in a second,
**permanent** file, `predeploy-decisions.json`. The rule is **essentials only**:
if it can be fixed, it is fixed; if it can merely be deferred, it goes in the
expiring allowlist.

```json
{ "version": 1, "entries": [
  { "scanner": "checkov", "rule": "CKV_AWS_109",
    "scope": "infra/aws/kms.tf#aws_kms_key.recordings",
    "decision": "D160", "why": "why it cannot be fixed (20-600 chars)",
    "reviewed": "2026-10-01" } ] }
```

- **scope** is one exact `file` or `file#resource` (resource = the scanner's own id:
  checkov/trivy `aws_kms_key.x`, osv `name@version`). The finding's `:line` is
  ignored so entries survive line drift. No wildcards, directories or `..`.
  A path-only scope covers that rule in that one file only, so prefer
  `file#resource`.
- **decision** must exist in the project's decisions ledger (`maple.config.json`
  `docs.decisions`), else `decision-missing`; an unreadable ledger fails closed.
- **No expiry, but a forcing function**: `reviewed` older than
  `decisionsMaxAgeDays` (180) fails as `decision-review-overdue`; re-review means
  confirming it is still unfixable, then bumping the date.
- `decision-stale` when the scope matches no finding of a check that ran;
  `decision-invalid` for bad shape, duplicates, wildcard scope, unknown scanner,
  future date; `decision-uncommitted` when the file is untracked or modified.
  The file is hash-bound into the stamp and the guard hook asks the owner
  before any edit.
- The report prints these as their **own** line, never folded into a zero:
  `*** N DECISION-BACKED EXCEPTIONS (...) — NOT ZERO ***`, the rule `ESSENTIALS
  ONLY`, and one row per entry (`decisionExceptions` in the JSON report, plus
  `totals.decisionBacked` and a per-check `decisionBacked`).
- **Rule-wide scope (the one sanctioned wildcard, D062)**: `"scope": "*"` with `"maxSeverity": "info"`
  covers every finding of that exact scanner+rule up to that severity, for advisory noise that belongs to the
  rule and not to any resource (a per-finding list would be dozens of entries). It needs the same D###, why and
  review date, goes stale when it matches nothing, a finding of the same rule above the ceiling still blocks, and
  the report lists it with its count (`* (rule-wide, up to info)`) — never hidden.
- Precedence: a finding is first matched against decision entries, then against
  the allowlist. The suppression-audit scan skips both exception files.

## Stamp and enforcement

`/predeploy-gate` (`plugin/scripts/predeploy/run.mjs`) runs every check on a
clean tree and writes `<git-common-dir>/maple/predeploy/stamps/<sha>.json`
bound to the sha, a hash of the `predeploy` config and a hash of the allowlist.
`verify.mjs` (exit 0/1) is the check deploy scripts call. The
`predeploy-guard.mjs` PreToolUse hook (Bash, PowerShell, Write, Edit) blocks any
command matching `deployGuard.patterns` unless the stamp verifies (sha, TTL,
config + allowlist hashes, clean tracked tree, no unscanned live deploy), and
blocks tool writes to the stamp directory itself. Stamps also bind a hash of the decision-backed file. An unparseable
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
