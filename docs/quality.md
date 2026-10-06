---
type: guide
title: Quality — the enforcement matrix
description: the enforcement matrix: every gate/hook, what it enforces, where it runs.
tags: [quality, ci, gates]
timestamp: 2026-10-06
audience: anyone asking "what stops bad code from landing here?"
authoritative_for: [the gate/hook/CI inventory and its philosophy]
code: [scripts/ci-local.sh, scripts/ci-local.ps1, scripts/run-gate.mjs, .husky/pre-commit, .husky/pre-push, eslint.config.mjs, .dependency-cruiser.cjs, knip.jsonc, vitest.config.ts, e2e/playwright.config.ts, maple.config.json, scripts/check-docs-drift.mjs, scripts/check-types-fresh.mjs, plugin/scripts/prepush/prepush-lib.sh, plugin/scripts/gate, plugin/scripts/agent-wt/maple-land.sh, plugin/scripts/agent-wt/maple-queue.sh, plugin/scripts/docs/check-docs-touched.mjs]
---
# Quality — the enforcement matrix

**Enforce by mechanism, not by trust.** Discipline drifts; a CI check, a
hook, or a compile error doesn't. Every rule in [[../CLAUDE.md|CLAUDE.md]]
is (or becomes) one.

## Stage matrix (D066: light landings, batched heavy runs)

What runs where. A landing must be light; the expensive checks run **batched** - daily and before production
promotion - so dev may be red between heavy runs, production never is.

| Stage | Runs | Docker | Typical |
|---|---|---|---|
| **pre-commit** (`.husky/pre-commit`) | staged-file `eslint --max-warnings=0 --no-warn-ignored` (same flags as the gate) + the cheap migration-name check. No `tsc`. | no | seconds |
| **pre-push / landing** (`gate`, `.husky/pre-push`, `/wt-land`) | the **affected-only fast tier** (below); plugin **unit** suites; a non-blocking docs-sync warning in the summary. Tree-bound pass stamp. | **no** | < 3 min |
| **fast** (`pnpm ci:fast`) | the same checks, **complete** (never affected-only). | no | minutes |
| **heavy** (`pnpm ci:heavy`; daily via `heavy-run.mjs`) | fast (complete) + plugin **integration** suites + types-freshness + live RLS + all desktop E2E on a gate-only port + Deno typecheck of Edge Functions + Jev audit + dependency freshness since the last heavy pass + `pnpm audit`. Writes the **heavy stamp** on green. | **on demand** (D052) | tens of minutes |
| **production promotion** (`predeploy` verify, D060) | everything D060 requires **plus** a green heavy stamp for the exact `HEAD` sha **and** zero unpaid gate debt. | - | - |

`core` and `full` are gone: the old pre-merge/nightly breadth is the heavy tier. `pnpm ci:core|ci:full` no longer exist.

### The checks (`scripts/ci-local.sh`)

`fast` / `gate` run, in order: eslint `--max-warnings=0` -> tsc -> knip -> depcruise -> vitest (two projects: `node`
for `src/lib` + `src/services`, `jsdom` for the rest) -> plugin **unit** suites (`loops`, `agent-wt`, `jev`,
`predeploy`, `deps`, `gate`, plus the prepush toolkit) -> `next build` -> docs-drift -> dep-freshness (D064).
Plugin suites split by file name: `*.test.*` is the unit set (fast/gate), `*.integration.test.*` runs only in `heavy`
(`pnpm test:plugin-integration`; Docker, network, scanners, minutes of real git/worktree work).

## Affected-only (`gate`)

`gate` does not re-run the world on every push or landing. It resolves the push range (the hook's own refs when
`CI_PREPUSH=1`, else `@{upstream}`, else `origin/<default>`) and runs only the checks the changed paths can affect:
changed-file eslint (`--cache`, per checkout), `tsc --incremental` for `.ts/.tsx/.mts` changes, `vitest related`,
knip/depcruise only when the import graph may have changed (a file added/deleted or an import/export line edited) or
their **own** config did, `next build` only for `src/`/`public/`, each plugin unit suite when its own directory or a
shared plugin file changed, docs-drift only for `docs/`, the checker or a deleted path, dep-freshness only when a
`package.json`/config/ledger changed. Every step prints "ran" or "skipped (reason)"; the table is repeated at the end
**with per-step seconds and the wall time**, so nothing is skipped silently and the budget is measurable.

- **Fails closed to the complete fast tier** when `--full` / `CI_FULL=1` is passed, when no range resolves, or when a
  gate script (`scripts/ci-local.*`, `plugin/scripts/prepush/`, `.husky/`), a lockfile / `package.json`, or a shared
  config (tsconfig, eslint/vitest/next config, `maple.config.json`) changed. Configs that affect **one** tool
  (`knip.jsonc`, `.dependency-cruiser.cjs`, `.gitleaks.toml`) escalate only that tool's own step.
  `fast` and `heavy` are always complete.
- **Tree-bound pass stamp.** A green `gate` on a clean tracked tree records `.git/ci-gate-pass/gate-<tree sha>` (same
  stamp across worktrees). The same tree is not re-run, so the landing queue's gate plus the push it makes run the
  gate once. It never satisfies another tree sha, a dirty tree, a larger change set, or an explicit `--full`.
- **Docs-sync warning (non-blocking).** `plugin/scripts/docs/check-docs-touched.mjs` maps changed code to the docs
  that own it (doc frontmatter `code:`) and prints, after the summary, every doc whose owned code changed while the doc
  and `CHANGELOG.md` did not. It replaces the removed Stop-hook reminder: the right moment is the landing.
- **Machine-wide gate slots.** Only the genuinely heavy steps take one of `MAPLE_GATE_SLOTS` (default 2, `0` disables) slots stored under
  `%LOCALAPPDATA%/maple-gate-slots`, shared by every worktree and repo. Waiting gates print "waiting for gate slot
  (k ahead)"; a dead PID frees its slot; after `MAPLE_GATE_SLOT_WAIT` seconds the gate runs anyway (a politeness
  limiter, never a skip). In `ci-local.sh` (D066) lint, tsc, knip, depcruise, vitest, the plugin unit suites, docs-drift and dep-freshness are **light** (no slot: a landing must not queue behind other repos' builds before it has done any work - 75-153 s waits were measured ahead of the first lint); `build`, the plugin integration suites, the live tier and the audits take a slot. Caches and locks are per checkout. Every wait uses a **sandbox-safe sleep**
  (`pp_sleep` / `maple_sleep`): the Claude Code Bash sandbox denies `/usr/bin/sleep`, so the helper falls back to a
  `read -t` timeout over a private FIFO.
- **Hooks fail closed in every worktree.** husky's `core.hooksPath` is the relative `.husky/_`, generated by `npm ci`
  and gitignored, so a worktree that never ran `npm ci` silently ran NO hook (pushes went out ungated).
  `scripts/install-hooks.mjs` (run by `prepare`; delegates to `plugin/scripts/prepush/install-hooks.mjs`) sets one
  absolute `core.hooksPath` = `<git-common-dir>/maple-hooks` per clone: thin stubs that run the worktree's committed
  `.husky/<hook>` and refuse when it is missing. `pnpm hooks:check` verifies; the `gate` tier, `/wt-start` and `/wt-land`
  call it.
- **Pushes are concurrency-proof.** The pre-push hook first `git fetch`es the target branch and refuses at once if the
  pushed commit does not contain the remote tip ("main moved to <sha> ... - rebase onto it and push again"), before
  any gate work. It then takes a per-branch **landing lock** (`<git-common-dir>/landing-locks`, shared by every
  worktree and session; holder = `CLAUDE_SESSION_NAME` or user@host, branch, worktree, pid, pushed sha), re-checks,
  gates, and re-checks once more after the gate. A second pusher waits, printing who holds it; a dead holder pid frees
  it. The landing queue (below) takes the same lock, so a raw `git push` cannot bypass it. Target refs:
  `MAPLE_LAND_REFS_RE` (default development|production|main|master).
- **Reusable toolkit.** `plugin/scripts/prepush/prepush-lib.sh` (tested by `pnpm test:plugin-prepush`) holds the range,
  selection, stamp, cache, lock, slot and sleep logic; other projects vendor it into their own `ci-local.sh`
  (EasyCaller: `scripts/lib/prepush-lib.sh`). Decisions use bash builtins only, because a fork costs seconds on a
  loaded Windows box.

## One runner

`scripts/ci-local.sh` is the only gate runner (D066). `scripts/ci-local.ps1` is a **shim**: it finds Git for Windows'
bash (`git --exec-path` -> `<Git>\bin\bash.exe`, else `C:\Program Files\Git\bin\bash.exe`), refuses WSL's
`System32\bash.exe`, and execs `ci-local.sh` with the same arguments. `pnpm ci:fast|gate|heavy` go through
`scripts/run-gate.mjs` (same Git-Bash lookup, so a `bash` that resolves to WSL on PATH cannot break them);
`ci:*:win` call the shim. The old PowerShell mirror drifted (predeploy tests were `tool-missing` / crashed under
`.ps1` yet green under `.sh`); there is nothing left to drift.

## The landing queue (`/wt-land`, `maple-land.sh`)

Landings are **batched**, not serialised one gate at a time:

1. Each `/wt-land` enqueues its branch under `<git-common-dir>/maple/land-queue/<remote>--<target>/`.
2. The first lander to take the owner lock (`<git-common-dir>/maple-land.lock`) becomes the **queue owner**. It
   rebases every queued branch, **FIFO**, onto `<remote>/<target>` in a throwaway integration worktree
   (`.worktrees/_land`). A branch that conflicts is **returned to its owner** (the others continue).
3. It runs **one** gate (`ci.tiers.gate`) on the combined tip and fast-forward-pushes; every lander learns its own
   verdict (landed / conflict / gate failed) and prunes its own worktree.
4. On a **red gate** it **bisects**: gate the first half, narrow to the smallest red prefix, return that breaking
   branch, rebuild the batch without it and land the rest (a single-branch batch is simply returned). The tree-bound
   stamp keeps the re-gate of an unchanged prefix cheap.
5. The owner keeps draining until the queue is empty, so branches arriving during a gate join the next batch.

**A lock is never stolen from a live process.** It is stale only when its holder pid is dead (a lock directory with
no readable pid is reclaimed only after a 120 s grace - an owner that died between `mkdir` and writing its pid; a
corrupted pid never makes a live holder look stale). The old TTL steal (900 s while real gates took 11-95 min) is
gone, and so is `worktrees.lock.ttlSeconds`'s effect. Dead landers' queue entries are dropped. `--no-push` rebases +
gates one branch behind the owner lock and pushes nothing; `--keep` keeps the worktree. The Jev audit no longer runs
inside a landing (it is a heavy-tier step; D066 amends D059).

## The heavy tier

`pnpm ci:heavy` (or the scheduled `plugin/scripts/gate/heavy-run.mjs`) runs, in order: `fast` (complete, builds once)
-> plugin **integration** suites -> dependency freshness over **everything changed since the last green heavy run** ->
live tier -> Deno typecheck -> Jev audit (`quality.jevAudit.enabled`, changed functions since the last heavy pass) ->
`pnpm audit`.

- **Live tier.** Local Docker stays on demand (D052): heavy starts the Supabase stack only if it is not already up,
  strips the restart policies (`docker update --restart=no`), `db reset`s it, runs types-freshness + the RLS suite, and
  **stops it again if it started it**. Playwright runs `next start` of the heavy run's own build (built once;
  `E2E_SKIP_BUILD=1`) on **port 3100** (`E2E_PORT`), `reuseExistingServer: false` - it can never pass against another
  checkout's dev server, and nothing on port 3000 is touched.
- **Stamp.** Green writes `<git-common-dir>/maple/heavy-pass/<sha>.json` and **pays gate debt** for every commit the
  sha contains. A run with any skipped step writes **no stamp** and pays nothing.
- **Scheduled run** (`heavy-run.mjs`): fetch `<remote>/<target>`, exit if that sha is already stamped, take
  `heavy-run.lock` (never from a live pid), add a detached temporary worktree `.worktrees/_heavy-<sha8>`
  (node_modules junctioned from the main checkout), run `ci.tiers.heavy` (default `pnpm ci:heavy`) with output to
  `<git-common-dir>/maple/heavy-runs/<ts>-<sha8>.log`, write `<ts>-<sha8>.json` (green / red / partial / timeout, with
  the log tail on failure), then **always** remove the worktree via `maple_remove_worktree` (strips junctions first,
  D012). The owner's checkout and dev server are never touched. Register it with Task Scheduler (owner-run, below).

```powershell
# One-time, run by the owner (this is persistent configuration; agents never register it):
$a = New-ScheduledTaskAction -Execute 'C:\Program Files\nodejs\node.exe' `
  -Argument '"C:\Projects\Maple-Standard\plugin\scripts\gate\heavy-run.mjs" --root "C:\Projects\Maple-Standard"'
$t = New-ScheduledTaskTrigger -Daily -At 3:30am
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Maple heavy gate (Maple-Standard)' -Action $a -Trigger $t -Settings $s
# one per project; consumers point -Argument at the installed plugin's scripts\gate\heavy-run.mjs and their own --root
```

## Gate debt (`MAPLE_GATE_SKIP`)

The old `SKIP_LIVE_GATE=1` claimed to "record the skip" and recorded nothing. It is replaced by
`MAPLE_GATE_SKIP=<reason>`, which accepts **only listed reasons** and **verifies** them:

| Reason | May skip step | Honoured only when |
|---|---|---|
| `docker-unavailable` | `live` | `docker info` fails, **or** a port in `supabase/config.toml` cannot be bound (e.g. a Windows excluded range) |
| `registry-unreachable` | `dep-freshness` | the npm registry does not answer |

An unlisted reason fails the run before any work; a reason that is false on this machine is refused (the step runs); a
valid reason for another step is ignored. Each honoured skip appends one line to `<git-common-dir>/maple/gate-debt.jsonl`:

```json
{"sha":"26772a7...","branch":"main","step":"live","reason":"docker-unavailable","at":"2026-10-06T08:00:00.000Z","who":"maayan@host","ref":"#T15"}
```

A **green heavy run on a sha containing those commits** appends `{"paid":true,"of":...,"by":"<heavy sha>"}`.
`pnpm gate:debt` lists unpaid debt; `node plugin/scripts/gate/gate-cli.mjs verify` checks promotion. `SKIP_LIVE_GATE=1`
survives only as a deprecated alias for `docker-unavailable` (and is held to the same verification). `--no-verify` is
forbidden - see CLAUDE.md "No bypass".

## Production promotion

`plugin/scripts/predeploy` `verifyStamp` (used by the deploy guard and `verify.mjs`) requires, **in addition to**
everything D060 already requires (sha/config/allowlist/decisions/image-debt-bound stamp, clean tree, live-scan debt):

1. `<git-common-dir>/maple/heavy-pass/<HEAD sha>.json` - a green **full** heavy run on exactly this commit; and
2. **zero unpaid gate debt** among the commits HEAD contains.

There is no knob to turn this off. A repo adopting the standard must configure `ci.tiers.heavy` and run the heavy tier
(or schedule `heavy-run.mjs`) before it can deploy; the refusal message says which of the two is missing.


## Cloud CI (`.github/workflows/`)

| Workflow | Enforces | Cadence |
|---|---|---|
| quality.yml | lint/tsc/knip/depcruise/vitest/build/docs-drift (requirable check) | push, PR, daily |
| supabase-migrations.yml | migrations apply clean + `database.types.ts` freshness | supabase/** changes |
| codeql.yml | SAST (security-extended) | push, PR, weekly |
| snyk.yml | SAST + SCA (token-conditional, quota-aware) | daily schedule |
| gitleaks.yml | secret scanning (diff on PR, full history weekly) | PR, push, weekly |
| zap.yml | DAST baseline vs staging URL | weekly |
| drift-sentinel.yml | prod schema == migrations (`db diff --linked`) | migrations push, weekly |
| dependabot-automerge.yml | validates dep bumps; automerges safe classes | Dependabot PRs |

## Always-on hooks

Claude Code hooks live only in the plugin (D065). One PreToolUse dispatcher
(`plugin/hooks/guard.mjs`) runs the guard modules in-process for Bash and
PowerShell alike, plus Read/Grep/Glob, file edits and MCP tools: credential
reads (any shell verb), git-hook bypass (`--no-verify`, `core.hooksPath`,
`HUSKY=0`), the deploy gate (baseline wrangler/supabase/terraform/vercel
patterns + pushes to the prod branch), prod Supabase MCP mutations, worktree
placement, hand-written dependency versions, the cwd/push/clean shell
hazards and the loop budget; `scrub-secrets` redacts tool output. The
template registers none of them: its `.claude/settings.json` holds only the
SessionStart branch echo, and `check-hook-wiring.mjs` (fast tier) fails any
project copy. Lint, size caps and types run at commit and in the gate tiers,
not as per-edit hooks. Git hooks (`.husky/`): staged lint+tsc + migration
naming (pre-commit), the gate tier (pre-push).

**Dependency freshness (D064).** Agents write versions from memory, so new
dependencies land outdated. The plugin's `dep-version-guard` denies
hand-written dependency versions in any `package.json` (use `pnpm add`);
`bash-guard` denies `add pkg@<version>` behind the latest major; the fast-tier
`check-dep-freshness` gate fails any dependency added/changed vs the target
branch that is behind the latest major (0.x: minor), and fails when the
registry is unreachable. pnpm `minimumReleaseAge: 1440` keeps "latest" safe.
Exceptions live in `maple.config.json` `deps.exceptions[]`, each citing a
D### in the decisions ledger.

Full per-gate detail: the README's "What's enforced" table.
