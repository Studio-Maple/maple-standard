---
type: guide
title: Pre-deploy gate
description: the enforced zero-findings gate in front of every deploy: checks, allowlist, stamp, guard hook, live ZAP policy, emergency override.
tags: [quality, gates, security, deploy]
timestamp: 2026-10-07
audience: anyone about to deploy, configuring the gate for a project, or blocked by the deploy guard
authoritative_for: [the pre-deploy gate's rules, stamp model, live-scan policy, allowlist format and enforcement]
code: [plugin/scripts/predeploy/, plugin/hooks/guards/deploy-guard.mjs, plugin/commands/predeploy-gate.md, plugin/templates/predeploy-remote.yml]
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
| `imageDebt` | opt-in dated third-party image debt ledger: `{ ownImages: [...], file?, maxDays? }` (below, D063) |
| `minSeverity` | per gate / per check floor, default `info` (everything counts) |
| `stampTtlHours`, `allowlistMaxDays` | defaults 72 / 90 |
| `remote` | `{ workflow, ref?, timeoutMin, pollSec }` for the single dispatch workflow |
| `deployGuard.patterns[]` | `{ id, regex }` ADDITIONAL deploy commands the guard blocks; the built-in baseline (wrangler deploy/pages deploy, supabase db push/functions deploy, terraform apply, vercel --prod) and `git push` to `repo.prodBranch` always apply; an explicitly empty list is an error (D065) |
| `emergency` | `{ enabled: false, maxMinutes: 60 }` owner-only override |
| `liveScan` | the aggressive post-deploy ZAP scan (below) |
| `runs` | `{ keep: 5, maxGB: 10 }` retention of the disposable run workspaces (D068, below) |
| `minFreeGB` | free GB the repo drive must have before a gate or live scan starts, default 20 (D068) |

Validation (`validate-config.mjs`) rejects any check command that hides its
own failure (`|| true`, `--exit-zero`, `--no-exit-code`, `--max-warnings=N`,
raised audit/severity floors) and a disabled guard. There are no silent
thresholds: exceptions live in exactly two files, the expiring allowlist and the decision-backed list below.

## Presets

`gitleaks` (tree + full history), `semgrep` (`--disable-nosem`), `osv-scanner`
(every tracked lockfile, dev deps), `npm-audit`, `trivy-fs`, `trivy-image`,
`shellcheck` (style), `actionlint`, `hadolint`, `checkov`, `tflint`,
`terraform` (init/validate/fmt), `deps-freshness`, `supabase-advisors`,
`gh-alerts`, `snyk`, `suppression-audit`. File scanners run on a clean `git archive`
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

**Snyk** (`snyk`): `snyk test --all-projects --dev --severity-threshold=low` over the clean candidate tree. The account
token is read just-in-time from the credential store (`options.tokenCredential`, default `Snyk-Token`; Windows Credential
Manager via the CredentialManager module) and given to the snyk child as `SNYK_TOKEN` in its environment only: never set in
the gate process, never written to a file/report/argv, and `snyk auth` (plaintext config) is never used. A missing token or
CLI, an auth failure, "no supported projects" or an unparseable result is a finding, never a skip; `.snyk` policy files are
removed from the scan copy so ignores cannot hide a finding.

**Stale** (`deps-freshness`): any deprecated package in a lockfile (direct or
transitive); a direct dependency more than 1 major behind, or not on latest
and published more than 12 months ago. Both numbers are options.

**semgrep timeout** (`semgrep` preset): `options.timeout` (whole seconds, optional) passes semgrep's per-rule,
per-file `--timeout`. Unset keeps semgrep's default of 5 s. A rule that times out is a scanner error, and the gate counts scanner
errors as findings, so a very large file on a loaded machine can fail the gate on speed alone. A higher limit lets every rule
finish; it skips nothing and is configuration, not a suppression.

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
- **Optional `expires`** (`YYYY-MM-DD`, at most `reviewed` + `decisionsMaxAgeDays`) for an exception with a known
  removal trigger (e.g. a rollback host destroyed in a later phase). Past it the entry excepts nothing and is a blocking
  `decision-expired` finding (like an allowlist expiry); the report row shows `expires`. Put the trigger in `why`.
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

## Third-party image debt (dated, shrink-only; D063)

Third-party images we run but cannot patch ourselves (a jambonz stack, mysql, redis, ...) can carry thousands
of findings that do not reach zero by the next deploy. This is **not** an allowlist and nothing is hidden:
`predeploy.imageDebt` opts a project into a committed, dated ledger, `predeploy-image-debt.json`.

```json
"imageDebt": { "ownImages": ["call-plane", "srs"], "file": "predeploy-image-debt.json", "maxDays": 30 }
```

```json
{ "version": 1, "entries": [
  { "name": "mysql", "ref": "mysql:8.0@sha256:...", "owner": "Maayan",
    "plan": "patch-layer rebuilds / version bumps tracked in #T214",
    "due": "2026-10-11", "baselined": "2026-10-02",
    "findings": [ "CVE-2024-1234|libssl3@3.0.1|mysql:8.0 (debian 12)" ] } ] }
```

- **Coverage**: every `trivy-image` image that is not in `ownImages` must have an entry (even with an empty
  snapshot) else `image-debt-unlisted`; `ref` is the exact pin (`context:<dir>` for a tree build on a third-party
  base). An entry for an image no longer pinned is `image-debt-stale`.
- **Our own images** (`ownImages`) can never be listed (`image-debt-own-image`); they must be zero.
- **No growth**: a finding of a listed image that is not in its snapshot (a new CVE) stays a blocking finding and
  adds `image-debt-growth`; a changed pin/digest is `image-debt-ref-changed` until re-baselined.
- **Dated**: after `due` any remaining finding fails (`image-debt-overdue`). `due` must be at most `maxDays`
  (default 30) after `baselined`; re-baselining never moves it.
- **Shrink is allowed** and reported as progress (`N fixed since the snapshot`).
- The file must be committed and unmodified (`image-debt-uncommitted`); the stamp binds its hash and the guard hook
  asks the owner before any edit.
- **Reporting**: in-snapshot findings are never counted as zero and never mixed into the blocking count. The
  report prints `*** THIRD-PARTY IMAGE DEBT: N findings across M images, due YYYY-MM-DD - NOT ZERO ***` plus a row
  per image (owner, due, days left, plan); JSON: `imageDebt`, `totals.imageDebt`, per-check `imageDebt`.
- **Adding findings** to the accepted debt needs an explicit run whose output is committed:
  `node run.mjs --rebaseline-image-debt [--owner X --plan "..." --due YYYY-MM-DD]` re-scans every
  `trivy-image` check, refuses if any scan failed, rewrites the snapshots (existing owner/plan/due are kept; the
  flags are only for new entries; `due` must be within `maxDays`) and prints `+added/-removed` per image. It issues
  no stamp; review the diff and commit it.

## Run workspaces and disk hygiene (D068)

Incident 2026-10-07 (EasyCaller): every gate run left its clean-room copy and scanner artefacts under
`<git-common-dir>/maple/predeploy/runs/<id>` and every live scan left `runs/live-<ms>`, forever; 298.5 GB later C: had 0 bytes
free, Docker froze and agents could not create worktrees. A run dir is now a **disposable workspace** (`plugin/scripts/predeploy/runs.mjs`):

- **Prune at run end** (a `finally`, so pass, fail and exception alike): the `tree/` scan copy, every link and every artefact larger than
  2 MB (image tars, ZAP reports) are deleted. Kept per run: `runs/<id>/run.json` (sha, exit code, times) and small scanner reports in
  `out/`, for debugging a failed run. A live scan keeps its container log's tail as `live-scans/<id>.zap.log` and its ZAP report as
  `live-scans/<ts>-zap-report.json` (as before).
- **Prune at start** of every gate / live scan (covers killed runs): dirs whose pid lock is dead are deleted; then the retention cap keeps the
  newest `predeploy.runs.keep` finished dirs (default 5) and at most `predeploy.runs.maxGB` GB (default 10) under `runs/`, oldest first, whichever is stricter.
- **Never a live run**: each run holds `runs/<id>/.run.lock` (pid + start time). A dir whose owner pid is alive (a concurrent gate in the same repo) is never
  deleted, not even by `prune --all`; a second gate on the same sha while the first runs gets a `<sha>-<pid>` dir instead of clobbering it. A lock older than 24 h
  counts as stale (pid reuse).
- **Free-space floor**: a gate or live scan refuses to start when the repo drive has less than `predeploy.minFreeGB` (default 20) free, checked **after** the start
  prune; the message names the free space, the `runs/` size and count, and the prune command.
- **Links are never followed** (D012): a run dir can hold `node_modules` junctions into the real checkout. Deletion uses `lstat`, unlinks every
  symlink/junction as a link and recurses only into real directories.
- **Never pruned**: `stamps/`, `reports/`, `deploys.jsonl`, `live-scans/`, `emergency.*` and `tf-plugin-cache/` (a reusable cache; `doctor` reports its size). `runs` and
  `minFreeGB` are not part of the config hash, so retuning them never invalidates a stamp.
- **Commands**: `run.mjs prune [--all]` (`--all` clears every finished dir) and `run.mjs doctor` / `doctor.mjs` (adds runs/ size and count, tf cache size, free space; a breach of the
  floor is a gap). The deploy guard lets an agent run exactly those two (`node <plugin>/scripts/predeploy/run.mjs prune|doctor` with `--all --json --dry-run --pull --root DIR`);
  `rm -rf` of `runs/` or any other write under `maple/predeploy` stays denied.

## Stamp and enforcement

`/predeploy-gate` (`plugin/scripts/predeploy/run.mjs`) runs every check on a
clean tree and writes `<git-common-dir>/maple/predeploy/stamps/<sha>.json`
bound to the sha, a hash of the `predeploy` config and a hash of the allowlist (also the decisions and image-debt files).
`verify.mjs` (exit 0/1) is the check deploy scripts call. The
`deploy-guard` (inside the PreToolUse dispatcher; Bash, PowerShell, Write, Edit) blocks any
command matching `deployGuard.patterns` unless the stamp verifies (sha, TTL,
config + allowlist hashes, clean tracked tree, no unscanned live deploy), and
blocks tool writes to the stamp directory itself. Stamps also bind a hash of the decision-backed file. An unparseable
`maple.config.json` fails closed. Projects also call `verify.mjs` from their
deploy script's preflight (belt and braces).

**Heavy promotion requirement (D066).** `verify.mjs` and the guard additionally require, on top of everything above, a green **heavy** run for the exact `HEAD`
(`<git-common-dir>/maple/heavy-pass/<sha>.json`, written by `pnpm ci:heavy` / the scheduled `plugin/scripts/gate/heavy-run.mjs`: live RLS + E2E, plugin
integration suites, Jev audit, dep-freshness; see [[quality]]) and **zero unpaid gate debt** among the commits `HEAD` contains (`MAPLE_GATE_SKIP` skips are
recorded in `gate-debt.jsonl` and paid only by a green full heavy run on a containing commit). The refusal says which of the two is missing. There is no
config knob to turn it off; a project must configure `ci.tiers.heavy` before it can deploy.

**Emergency override**: default off. `emergency.mjs --reason "..."` needs an
interactive terminal and the owner typing a phrase naming the sha; grants one
sha for `maxMinutes`, appended to `emergency.log.jsonl`, warned on every use.
There is no flag or env var.

## Remote-only part

One input-less workflow (template `plugin/templates/predeploy-remote.yml`)
for what needs a clean-room runner, triggered only by the lightweight tag
`predeploy/<sha>` the gate pushes (no dispatch inputs: checkov CKV_GHA_7). The
gate triggers it for the candidate sha (whose branch must already be pushed), waits, reuses a prior green run for the
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

**Reachability preflight.** Before Docker/ZAP starts, every target is probed once (`targetcheck.mjs`). A target that is
down - connection failure, Cloudflare 52x/530 or Cloudflare-rendered 502-504 error page - or, if it has no auth headers, answers
only with a Cloudflare Access login, makes the run stop with a blocking `target-down:<id>` finding ("scan not meaningful"). The
record is a failed live scan with `outcome: "target-down"` (deploy debt stays); no ZAP findings are produced about an error page.
Optional `schedule: { days, from, to, tz }` (on `liveScan` or a target) only adds a note saying whether the target was expected
to be up (a parked VM outside its window is the usual cause). Re-run the live scan inside the window.

## Commands

```
node plugin/scripts/predeploy/run.mjs [--check ID] [--list] [--json] [--pull]
node plugin/scripts/predeploy/run.mjs --live [--pull]     # after a deploy
node plugin/scripts/predeploy/livescan.mjs --dry-run      # write + print the ZAP plan, send nothing
node plugin/scripts/predeploy/verify.mjs                  # exit 0/1
node plugin/scripts/predeploy/doctor.mjs [--pull]         # missing tools / credentials by name, runs/ size, free space
node plugin/scripts/predeploy/run.mjs prune [--all]       # delete disposable run workspaces (agents may run this)
node plugin/scripts/predeploy/record-deploy.mjs --outcome failed
```
