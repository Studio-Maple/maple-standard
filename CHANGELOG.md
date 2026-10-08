# Changelog

All notable changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); newest first.

## [Unreleased]

- **Stack-exposure standard, enforced by the pre-deploy gate (plugin v0.14.0, D072).** From EasyCaller's 2026-10-08 audit: its
  login page preloaded 82 app chunks and an anonymous crawl fetched 220 files / 5.9 MB naming exact library versions, the whole
  inlined `import.meta.env` (commit SHA, internal hostnames, dev flags), Tailwind's banner and a dev-only route. New preset
  `stack-exposure` (`plugin/scripts/predeploy/exposure.mjs`): builds each configured surface and fails on served source maps,
  sensitive files (.env, package.json, lockfiles, .vite manifest), `/*!`/`@license` banners, inlined env objects, the candidate SHA,
  lockfile package versions next to their names, non-hash asset names, dev routes, forbidden strings and an over-budget static login
  graph; plus nginx blocks without `server_tokens off` and express without an x-powered-by disable in the tracked tree. Findings are
  one per rule + surface + key (location = surface dir, resource = package/key), so an unavoidable item is one decision-backed entry.
  Live half (`exposure-live.mjs`), run anonymously by `predeploy-gate --live` before ZAP: versioned `Server`, `X-Powered-By`,
  version headers (or the SHA in any header), `Via` versions, server banners / stack traces / framework default errors in bodies
  (target URL, `/__maple-exposure-probe`, configured probes; call-origination paths refused), optional anonymous login crawl with
  file/byte budgets, `allowCode`, app markers and the bundle text rules. **Required by default** (`exposure-unconfigured`): adopters add
  the check or set `predeploy.exposure.optOut.bundle|live { decision, why }` with a D### from their own ledger (verified; missing =
  blocking). Config: `predeploy.exposure` (validated in `exposure-config.mjs`, schema JSON, plugin README). Tests:
  `exposure.test.mjs` (15 unit), 3 new e2e cases; gate integration fixtures opt out via a fixture decision.

- **Adopted shell files parse under semgrep (plugin v0.13.10).** semgrep's bash grammar rejects several valid constructs, and an adopter's predeploy
  gate counts an unparseable file as a `semgrep-error` finding. EasyCaller hand-fixed its vendored `prepush-lib.sh` (d920357a, e1c9be4c, 8de69d36) and every
  re-sync of the canonical file reverted it. The canonical `plugin/scripts/prepush/prepush-lib.sh` and the template `scripts/ci-local.sh` now use the parseable
  forms, behaviour unchanged: multi-line `case..esac`; `$_PP_NL` instead of `$'
'` in patterns; `_pp_dec` instead of `10#`; heredocs before `}` replaced by
  process substitution; no `<...>` inside `${v:-}`; `pp_sleep`'s read-write FIFO open goes through `eval` (semgrep has no `<>`; no fork-free non-eval spelling exists).
  The only visible text changes: the "no push range" FULL reason and the `<no base>` summary label lose their angle brackets. **Adopters can re-sync**: copy the plugin's
  `prepush-lib.sh` over `scripts/lib/prepush-lib.sh` (keep byte-identical) and re-copy the template `ci-local.sh` (or port its two `case` blocks and the `<merge-base>` text).
  Regression tests in `plugin/scripts/prepush/`: `semgrep-parse.test.mjs` (fast static guard for the known-bad forms) and `semgrep-parse.integration.test.mjs`
  (heavy tier: the real semgrep, native or Docker, must parse both files; fails closed if semgrep is unavailable).

- **The live scan refuses to scan a down target (plugin v0.13.9).** 2026-10-08 (EasyCaller): the VM was parked outside its schedule, Cloudflare answered with its own error pages
  (530 tunnel down, 522 origin timeout) and ZAP reported HSTS-missing findings about those pages instead of saying the target was down. `livescan.mjs` now probes every target
  before Docker/ZAP starts (new `targetcheck.mjs`): connection failures, Cloudflare 52x/530 and Cloudflare-rendered 502-504 error pages, and a Cloudflare Access-only wall on a target with
  no auth headers are classified as not scannable. Any such target aborts the run with a blocking `target-down:<id>` finding ("scan not meaningful", exit 1), recorded as a failed live
  scan with `outcome: "target-down"` (the deploy debt stays, with its own reason) - never a pass, never header findings. Optional `schedule { days, from, to, tz }` on
  `predeploy.liveScan` or per target adds a note ("outside its declared schedule - probably parked on purpose" / "unexpected outage"); config-validated, informational only. Tests:
  `predeploy/targetcheck.test.mjs` (fixture 530/522/502 pages, Access redirect, healthy and origin-502 responses, real local server probe, schedule, config, record + debt).

- **Landings stop reporting KEPT for an empty leftover (plugin v0.13.8, D069 follow-up).** Windows cannot delete a directory that
  is a process's cwd - the shell that started `maple-land` from inside the worktree. The fail-closed removal then reported KEPT even
  though every file and the git registration were gone (8 empty `.worktrees/*` dirs piled up on 2026-10-07). An empty leftover now
  counts as removed with a warning, and `maple-reap` gains a pass that `rmdir`s empty leftover dirs (refuses non-empty or in-use
  dirs, so it can never delete data or follow a link).

- **Landings no longer keep their worktrees (plugin v0.13.6, D069 follow-up).** `maple-lib.sh` looked for its link tools via
  `dirname "${BASH_SOURCE[0]}"`, which is relative when a script is started as `bash plugin/scripts/agent-wt/x.sh`; after `maple-land`
  cds to the main root for cleanup, the tools looked missing and the fail-closed removal (correctly) kept every landed worktree and
  `_land`. The lib dir is now captured as an absolute path at source time (existence still checked per call). Regression test
  `agent-wt/lib-dir-abs.test.mjs`.

- **Worktree removal fails closed; the plugin cache never deletes a version in use (plugin v0.13.5, D069).** Incident 2026-10-07 (EasyCaller): a plugin auto-update made
  `sync-plugin-cache` delete 0.13.0 while a 0.13.0 `maple-reap` was mid-run; the lib's captured `strip-reparse-points.ps1` path vanished, the error was swallowed and the junction
  strip silently did nothing (D012 - only the agent's own check saved the main `node_modules`). Now `maple_remove_worktree` resolves `strip-links.mjs` / `verify-no-links.mjs`
  (lstat-only node, never follows a link; replaces the PowerShell script) at call time (own dir, `CLAUDE_PLUGIN_ROOT`, the repo's `plugin/`, newest cache version), strips, then
  re-scans with the separate verify script; a missing tool, node, a failed strip or any remaining link prints an error, returns non-zero and deletes nothing (the `rm` fallback re-scans too).
  `maple-reap` (counts it kept, keeps the branch), `maple-land` (keeps worktree and branch), the land-queue integration worktree (dies loudly) and `heavy-run` (reports) treat it as kept.
  `sync-plugin-cache` now reclaims superseded versions on every run, only after a 24h grace (`MAPLE_SYNC_GRACE_HOURS`) and never while a live pid is in the version's `.in_use/`
  (written by `maple-lib.sh` at source time; dead pids are cleaned). Tests: `junction-safety` (missing tool, no-op strip, normal path) and `sync-cache-inuse`.
- **Secret scrubber regression fixed; `run-gate.mjs` Git Bash path fixed (plugin v0.13.4, D070).** D065 removed EasyCaller's project copy of `scrub-secrets`, which caught more than the
  plugin's. The plugin hook now ports every missing pattern: Supabase `sb_secret_` keys (`sb_publishable_` is public and left alone), AWS temporary `ASIA` ids (word-bounded),
  labeled AWS secret access keys and session tokens (`aws_secret_access_key`, `AWS_SECRET_ACCESS_KEY`, `SecretAccessKey`, `aws_session_token`, `SessionToken`; any case), labeled Cloudflare API
  tokens and global keys (`CLOUDFLARE_API_TOKEN`, `CF_API_TOKEN`, `CLOUDFLARE_API_KEY`, `X-Auth-Key`). Labeled values are context-bound so 40-char git SHAs are not redacted. `docs/` reads are
  now scrubbed too (the skip is gone). `scripts/run-gate.mjs` had `"C:\Program Files\Git\bin\bash.exe"` in a normal JS string (backslashes eaten, `\b` a backspace), so its fallback never
  matched; it now imports the plugin's `find-bash.mjs` (this repo's `./plugin`, `$MAPLE_PLUGIN_DIR`, `$CLAUDE_PLUGIN_ROOT`, else the newest installed plugin copy). Tests:
  `plugin/scripts/hooks/scrub-secrets.test.mjs` (positive + near-miss per pattern, docs, matcher covers PowerShell), `plugin/scripts/gate/run-gate.test.mjs`.

- **The heavy tier runs against an isolated throwaway Supabase stack, never a dev stack (plugin v0.13.7, D071).** The heavy tier used the owner's own dev stack: in VeHagita it held
  migrations of unlanded branches (types-freshness red) and `db reset` would wipe the owner's local data; EasyCaller hit the same risk. New `ci.stack { portBase, projectId?, exclude? }`
  in `maple.config.json` (schema, `validate-config.mjs`, plugin schema JSON) and `plugin/scripts/gate/ci-stack.mjs up | env | status | down` (+ `ci-stack-config|docker|env|lock.mjs`),
  generalised from EasyCaller's `ci-supabase.mjs`: a copy of `supabase/` under `<git-common-dir>/maple/ci-stack/<id>/` with `project_id` `<dev id>-ci` and every port in
  `portBase..portBase+9` (role-stable slots), `--workdir`-bound CLI calls with an argv guard, Docker objects removed only after their project label is verified to equal the CI id,
  refusals when the id equals the dev id or any port is shared, a pid lock that never robs a live owner (dead owner: reclaimed + orphans swept), fresh volume per run, `down` from the
  EXIT trap, `env` printed for `eval` only (secret-bearing). `scripts/ci-local.sh heavy` uses it when `ci.stack` is set (template block 56420-56429) and otherwise warns loudly that it
  uses the dev stack; `scripts/check-types-fresh.mjs` honours `CI_SUPABASE_WORKDIR`; the `docker-unavailable` skip verification checks the CI block; `dockerWorks` waits up to 90 s (a
  loaded Docker Desktop needs 10-60 s for `docker info`). Unit set `ci-stack.test.mjs`, integration `ci-stack.integration.test.mjs` (really starts and stops the stack and diffs the dev
  stack's containers/volumes). Docs: [[quality]] heavy tier, [[docker]] (owner-run `netsh` for the block), plugin README step 5b.

- **The pre-deploy gate prunes its run workspaces and refuses to fill the disk (plugin v0.13.2, D068).** Incident 2026-10-07 (EasyCaller): `<git-common-dir>/maple/predeploy/runs`
  grew to 298.5 GB because every gate run left its clean-room copy and scanner artefacts under `runs/<id>` and every live scan `runs/live-<ms>`, never pruned; C: hit 0 bytes
  free, Docker froze, a gate and a `supabase db reset` hung and worktree creation failed. Now (`plugin/scripts/predeploy/runs.mjs`): a run's scan copy and artefacts over 2 MB are deleted in
  a `finally` (kept: `run.json` + small reports; live scans keep the ZAP log tail in `live-scans/`); every gate/live start prunes first (dead-owner dirs, then `predeploy.runs`
  `{keep: 5, maxGB: 10}`, oldest first, stricter wins) and never touches a dir whose pid lock is alive; a start is refused when the repo drive has less than `predeploy.minFreeGB` (default 20)
  free, with the free space, `runs/` size and the prune command in the message; `run.mjs prune [--all]` and `doctor` (now also runs/ size and count, tf-plugin-cache size, free space).
  Deletion never follows junctions/symlinks (D012, tested with a junction into a sentinel dir). The deploy guard lets an agent run `run.mjs prune|doctor`; `rm -rf runs` and every other write under
  `maple/predeploy` stay denied. stamps, reports, `deploys.jsonl`, `live-scans/`, `emergency.*` and `tf-plugin-cache` are never pruned; the new keys are outside the config hash, so no stamp is invalidated.

- **Supabase MCP listings are answered with refs (plugin v0.13.1, D067).** The Supabase connector token lists only its default
  organization, while `get_project` and the other tools reach projects in the owner's other organizations by ref - sessions kept concluding
  "the connection only has VeHagita". `mcp-guard` now answers `list_projects` / `list_organizations` (Supabase-shaped calls only; a
  team-scoped `list_projects` of another platform passes) with the repo's refs (`supabase.prodProjectRefs`/`devProjectRefs`,
  `supabase/.temp/project-ref`) and tells the session to call tools by ref.

- **Gate v2: light landings, batched heavy runs, production unchanged (plugin v0.13.0, D066).** Evidence (2026-10-05/06): one green fast tier took 6 attempts over
  hours - all environment failures, zero code failures (global pnpm mismatch; PowerShell's `bash` was WSL; `ci-local.ps1` and `.sh` disagreed; the Claude Code
  sandbox denies `/usr/bin/sleep`; 75-153 s gate-slot queues), "fast" ran minutes-long integration suites whenever `plugin/` changed, `maple-land` held one lock
  across rebase->gate->push and **stole it from a live holder after 900 s** while consumer gates take 11-95 min, and `SKIP_LIVE_GATE` recorded nothing.
  What changed: **(1) stages** - pre-commit is staged-file lint (`--max-warnings=0 --no-warn-ignored`) + the migration-name check, no `tsc`; `gate` (pre-push and
  landing) is the affected-only fast tier with no Docker, no live tier and no plugin integration suites; new **`heavy`** tier = fast (complete) + plugin integration
  suites + types-freshness + live RLS + all desktop E2E + Deno typecheck + Jev audit (moved out of `maple-land`, amending D059) + dep-freshness since the last heavy
  pass; `core`/`full` are folded into it and removed. Plugin suites split by file name (`*.integration.test.*` = heavy only; shared runner
  `plugin/scripts/gate/run-suite.mjs`). The summary table now shows per-step seconds and the wall time. **(2) heavy runs** - `plugin/scripts/gate/heavy-run.mjs`
  fetches the target tip, runs `ci.tiers.heavy` in a detached `.worktrees/_heavy-<sha8>` worktree (removed via `maple_remove_worktree`, D012), writes
  `<git-common-dir>/maple/heavy-pass/<sha>.json` on green (or a report under `heavy-runs/` on failure); Docker stays on demand (D052: started if needed, restart
  policies stripped, stopped again if the run started it). The Task Scheduler registration is in `docs/quality.md` (owner-run). **(3) promotion** - `predeploy`
  verify additionally requires a green heavy stamp for the exact HEAD and zero unpaid gate debt, on top of everything D060 required. **(4) gate debt** -
  `MAPLE_GATE_SKIP=<reason>` replaces `SKIP_LIVE_GATE` and accepts only `docker-unavailable` (verified: `docker info` fails or a stack port is unbindable) and
  `registry-unreachable`; each honoured skip appends `{sha, branch, step, reason, at, who}` to `<git-common-dir>/maple/gate-debt.jsonl`, an unlisted reason
  fails, and a green heavy run on a sha containing the commits pays the debt (a run with any skip writes no stamp). **(5) landing queue** - `maple-land` enqueues;
  the first lander becomes the queue owner, rebases every queued branch FIFO in a throwaway `.worktrees/_land` worktree (a conflicting branch is returned), runs ONE
  gate on the combined tip, fast-forward-pushes, and on a red gate bisects to the breaking branch (returned) and lands the rest. **A lock is never taken from a live
  pid** (stale only when its holder is dead; the corrupted-meta safety stays; `worktrees.lock.ttlSeconds` is now ignored; the per-checkout gate lock follows
  the same rule). **(6) one runner** - `scripts/ci-local.sh` is canonical; `ci-local.ps1` is a shim that finds Git Bash (never WSL) and execs it; `pnpm ci:*` go
  through `scripts/run-gate.mjs` for the same reason. **(7) sandbox-safe waits** - `pp_sleep` / `maple_sleep` fall back to `read -t` over a private FIFO when
  `/usr/bin/sleep` is denied. **(8) E2E** - Playwright serves the gate's own `next start` build on port 3100 (`E2E_PORT`, `reuseExistingServer: false`, build once
  per heavy run via `E2E_SKIP_BUILD=1`); port 3000 is never touched. **(9) template ports** - `supabase/config.toml` moves every port to the 5632x block (Windows
  reserves 54207-54906 here); `docs/docker.md` has the owner-run `netsh` administered-exclusion command. **(10) faster fast tier** - vitest `node` + `jsdom`
  projects; `knip.jsonc`, `.dependency-cruiser.cjs` and `.gitleaks.toml` escalate only their own step instead of the whole gate. **(11) docs-sync at landing** -
  `plugin/scripts/docs/check-docs-touched.mjs` (frontmatter `code:` ownership) prints a non-blocking warning in the gate summary, replacing the Stop-hook reminder.
  **(12) dogfood** - a root `maple.config.json` (ci.tiers fast/gate/heavy, single-branch `main`) so `/wt-land` works in this repo. Tests: `pnpm test:plugin-gate`
  (skip validation, debt record/pay/verify, promotion, heavy stamps, docs-touched, bash finder, ps1 shim), `lock-safety.test.mjs`, `land-queue.integration.test.mjs`
  (FIFO + one gate, conflict return, bisect, live lock never stolen, dead lander dropped, `--no-push`), `heavy-run.integration.test.mjs`, plus the predeploy e2e
  promotion cases. The D065 deploy guard protects the new state too: hand-written heavy stamps, gate-debt edits, forged gate pass
  stamps and direct `gate-cli stamp|pay` calls are denied, so a promotion stamp exists only if a heavy run produced it. Consumers: see "Consumer migration (D066)" in `plugin/README.md`.
- **Hooks v2 (plugin v0.12.0, D065).** Hooks live only in the plugin and cost one process per call. Removed: the three Stop reminders
  (dirty-tree-guard, docs-sync-reminder, decision-reminder), parallel-session-warn (the husky pre-commit warning stays), ask-gate (supersedes the D054 hook and
  its nested `claude -p` judge) and the template's project copies and registrations (eslint-fix, size-warning, build-counter: measured 14-22 s per .ts edit and
  a 40 s `tsc` every fifth, invisible to the model; lint, size and types run at commit and in the gate tiers). The seven duplicated plugin hooks in
  `.claude/settings.json` are gone (only the SessionStart branch echo remains). `plugin/hooks/guard.mjs` is now the single PreToolUse hook (matcher
  `Bash|PowerShell|Read|Grep|Glob|Write|Edit|MultiEdit` plus the mutating Supabase MCP tool names): it lazy-loads the guard modules a tool needs from `plugin/hooks/guards/` and runs them in
  one process, first deny wins, no child process on the no-op path (loop-budget-guard checks an fs sentinel before any git call). One quote- and heredoc-aware
  shell tokenizer (`guards/shell.mjs`) serves Bash and PowerShell, so a commit message that mentions a flag is data. New: `hook-bypass` (no `--no-verify`/`-n`,
  `core.hooksPath`, `HUSKY=0`, `--no-gpg-sign`, `commit.gpgsign=false`); credential reads from any shell verb plus `.dev.vars`, private `.pem`, example/sample/template
  files exempt; deploy guard baseline (wrangler deploy/pages deploy, supabase db push/functions deploy, terraform apply, vercel --prod) that config can only
  add to (an explicitly empty `predeploy.deployGuard.patterns` is now a config error), `git push` to `repo.prodBranch` needs the stamp, `$(...)`/backticks are
  no longer exempt, fail-closed on its own deadline; `mcp-guard` (mutating Supabase MCP tools only on a `supabase.devProjectRefs` project; new
  `supabase.devProjectRefs`/`prodProjectRefs` config); `worktree-guard` (`git worktree add` only under `<main-root>/.worktrees/` or `.claude/worktrees/`, never
  nested; `pi-run.mjs` now builds its worktree under the main root); cwd-guard normalises `/c/...`, `C:/...`, `C:\...`. scrub-secrets also covers PowerShell.
  `plugin/scripts/hooks/check-hook-wiring.mjs` (fast tier) fails a project that registers or keeps a copy of a plugin/removed hook; `/adopt-standard` no longer
  plants hook copies. Tests: `pnpm test:plugin-hooks` (fixture-driven guard contracts, dispatcher process test, wiring check, config).
- **New dependencies enter at the latest release (plugin v0.11.0, D064).** Agents add dependencies at versions remembered from training, so they land a
  major behind. Three mechanisms, none trusting discipline: the `dep-version-guard` PreToolUse hook (`Write|Edit|MultiEdit`) denies any added or re-specced
  dependency in a `package.json` (use `pnpm add`; removals, scripts/config edits and workspace/file/link/git/tag specs pass; no network); `bash-guard` denies
  `pnpm|npm|yarn|bun add pkg@<version>` behind the latest major (0.x: minor) after a registry lookup (4 s, fail-open with a warning; timeout raised to 10 s);
  `plugin/scripts/deps/check-dep-freshness.mjs` is a diff-scoped `ci:fast` gate (every dependency added/changed vs the merge-base with the target branch,
  `npm:` aliases resolved, an unreachable registry fails). Exceptions are `maple.config.json` `deps.exceptions[]`, each citing a `D###` that must exist in the
  decisions ledger (schema + validator updated). This repo moves to pnpm 12.9.1 with `minimumReleaseAge: 1440` in `pnpm-workspace.yaml` (the gate and hooks honor
  it when choosing "latest"); `/adopt-standard` step 6b plants the same setting and the gate wiring in consumers. AGENTS.md: read the installed version's
  docs/types, not memory. Tests: `pnpm test:plugin-deps` (parsing, diffing, floors incl. 0.x/ranges/aliases/prereleases, release-age selection, exceptions,
  a real temp-repo gate run, hook processes).
- **Live scan never sends auth headers to third parties (plugin v0.10.9).** The `replacer.full_list(n)` auth-header rules had no URL scope, so ZAP
  added every target's headers (e.g. the Cloudflare Access `CF-Access-Client-Id`/`-Secret` service token) to EVERY proxied request, including the
  third-party fonts, CDNs, Turnstile and analytics the scanned pages load. Each rule now sets `.url` to an anchored regex of its own target's exact
  scheme + host (+ port); foreign hosts, sibling subdomains, other ports/schemes, `host.evil`/`host@evil` lookalikes never match. Verified against
  ZAP stable in Docker; regression test generates a multi-target plan and asserts no rule matches a foreign origin. Rotate any service token
  configured in `liveScan.targets[].headers` that was used by a live scan on <= 0.10.8.
- **Reap never destroys uncommitted work (plugin v0.10.8).** `maple-reap` removed any `agent/*` worktree whose branch was an ancestor of the target, with
  `git worktree remove --force` falling back to `rm -rf`. A fresh worktree (`-b agent/x origin/<target>`, zero commits) is trivially "merged", so its
  in-progress uncommitted edits were deleted. Reap now keeps, merged or `--force`d: any worktree with `git status --porcelain` output; a branch at the
  target tip whose HEAD reflog moved within `staleHours` (fresh, not landed; a fast-forward-landed one goes on a later run); and `git worktree lock`ed
  worktrees. Regression test `reap-fresh-worktree.test.mjs`.
- **Live scan actually authenticates (plugin v0.10.7).** `buildPlan` put auth headers in a ZAP `replacer` job as `replacementString: "${ZAPSCAN_Hn}"`;
  ZAP does not expand env vars there and sent the literal text, so every target with `headers` was scanned unauthenticated (Access 403 pages produced
  false findings). The plan now has no replacer job; each header becomes ZAP `-config replacer.full_list(n).*` options in an `sh -c` script whose
  `"$ZAPSCAN_Hn"` the container's shell expands from `docker run -e`, so values stay out of host argv, the plan and disk. Before ZAP starts, the script
  curls each authenticated target with its headers and aborts on 401/403, a Cloudflare Access redirect or no response; a spider 401/403 on the target
  URL is also caught. Both record a blocking `auth-rejected:<target>` finding and print a loud error. Verified against a local echo server; regression tests added.
- **Prepush scripts are shellcheck-clean without suppressions (plugin v0.10.6).** The predeploy gate runs `shellcheck --norc -x --severity=style` and audits for
  `# shellcheck disable`; the prepush toolkit (lib, three tests, land-lock.sh) and `scripts/ci-local.sh` had 100+ findings and 4 disables in EasyCaller's copy. Real
  if/then/else instead of `A && B || C`, `$'...'` snippets, argument arrays instead of unquoted splitting, exported cross-file variables, root-relative
  `shellcheck source=` directives. The template's own `ci-local.sh` (`run_live`) and `.husky/pre-commit` lose their last two disables too.
- **Nested gates inherit the parent's slot; tests are hermetic inside a hook (plugin v0.10.5).** A gate holding a machine-wide slot that ran a child gate
  (the ci-local self-test sandbox) made the child queue for a second slot: with the rest held by other sessions nothing progressed (a gate sat 30+ min).
  `pp_heavy_begin` now exports `PP_SLOT_INHERITED` and nested callers return at once. Also: `ci-local.sh` scrubs `git rev-parse --local-env-vars` once for
  the whole gate, and the prepush self-tests unset them, set `GIT_ALLOW_PROTOCOL=file` and abort (`must_be_temp`) unless every repo they create is inside their temp dir:
  run from a pre-push hook, git's exported `GIT_DIR` had let the tests re-initialise the real repo, set `core.bare=true`/a test user and add stray branches.
  The hook stub also finds the worktree root without `rev-parse` (a `core.bare=true` main checkout) and scrubs those variables before running the hook.
- **semgrep preset takes `options.timeout` (plugin v0.10.4).** The gate ran semgrep with its default 5 s per-rule timeout, and a timed-out rule
  is reported as a scanner error that the gate counts as a finding. Very large files (EasyCaller `softphone.test.ts`, 3,300 lines) time out
  reproducibly. `options.timeout` (whole seconds) is now passed as `--timeout`; unset keeps the default. No rule or file is skipped.
  `semgrepArgs` extracted and unit-tested.

- **Predeploy remote leg takes no workflow input (plugin v0.10.3).** checkov CKV_GHA_7 flags `workflow_dispatch` inputs that affect the build.
  The gate now pushes the lightweight tag `predeploy/<sha>` (`predeploy.remote.tagPrefix`) and the workflow runs on `push: tags: predeploy/**`,
  building `github.sha`; runs are found by `--event push` + headSha. A stale tag is deleted and re-pushed to re-trigger. `remote.inputName` is removed.
  Template updated; ordinary pushes still never run it (manual-only, D102 preserved).

- **Image-debt finding keys are stable across runs (plugin v0.10.1).** The scan target of an OS/package finding is the image tarball's path in the run
- **Image-debt finding keys are stable across runs (plugin v0.10.2).** The scan target of an OS/package finding is the image tarball's path in the run
  directory, which differs every run, so every finding looked NEW against a snapshot from another run. The tarball path is normalised to `<image>` in the key
  (`stableTarget`); existing snapshots are migrated by the same function (no rescan). Test added.
- **Concurrency-proof landing (plugin v0.10.1).** The pre-push hook now `git fetch`es the target branch and refuses AT ONCE ("<branch> moved to
  <sha> (<subject>, by <author>) - rebase onto it and push again") when the pushed commit lacks the remote tip, then takes a per-branch LANDING
  LOCK under `<git-common-dir>/landing-locks` (shared by every worktree/session; owner = the `git push` process, so it lives until the push ends and
  a dead pid frees it; the holder record names session via `CLAUDE_SESSION_NAME`, branch, worktree, pid, sha), re-checks staleness on acquiring and
  again after the gate. A second pusher waits, printing "waiting for landing lock on <branch>: held by <holder> since <time> (pushing <sha>)"
  (`MAPLE_LAND_WAIT` caps it). `/wt-land` takes the same lock through `plugin/scripts/prepush/land-lock.sh` and re-enters it for its own push, so a raw
  `git push` can no longer bypass the semaphore. `landing-lock.test.sh` (in `test:plugin-prepush`) covers staleness, wait/timeout, stale-pid reclaim,
  re-entry, release on failure and two real concurrent pushes. `docs/quality.md` updated.
- **Git hooks fail closed in every worktree (plugin v0.10.1).** husky 9 sets `core.hooksPath` to the RELATIVE `.husky/_`, a directory it generates
  (gitignored) on `npm ci`; the setting is shared by all worktrees, but a worktree that never ran `npm ci` has no such directory and git then
  silently runs NO hook, so pushes from it skipped the pre-push gate (several went out ungated, one in 2.7 s). New
  `plugin/scripts/prepush/install-hooks.mjs` (+ `scripts/install-hooks.mjs`, run by `prepare` after husky) points `core.hooksPath` at one
  ABSOLUTE `<git-common-dir>/maple-hooks` per clone, shared by the main checkout and every worktree: thin stubs that run the worktree's own
  committed `.husky/<hook>` and REFUSE when it is missing; `HUSKY=0` is not honoured. `--check` verifies it; the `gate` tier calls it first;
  `/wt-start` installs it, and `/wt-land` repairs-then-verifies it before pushing. `install-hooks.test.sh` (in `test:plugin-prepush`) proves it
  with real `git push`es from real worktrees. Because `npm ci`/husky reset the path to the relative one (seen within an hour of the first
  install), the same stubs are also written into every worktree's `.husky/_` and the committed hooks re-run the installer to heal it.
  Adopters vendor the installer as `scripts/install-hooks.mjs` and add it to `prepare`.
- **Affected-only pre-push gate + shared toolkit (plugin v0.10.0).** `scripts/ci-local.sh gate` (what `.husky/pre-push` runs) now selects
  checks from the push range (the hook's own refs, else `@{upstream}`, else `origin/<default>`): changed-file eslint (`--cache`, per-checkout
  cache), `tsc --incremental` only for `.ts/.tsx/.mts` changes, `vitest related`, knip/depcruise only when the import graph may have changed
  (file added/deleted or an import/export line edited), build only for `src/`/`public/` changes, each plugin suite when its dir (or a shared
  plugin file) changed, docs-drift only for `docs/`/checker/deleted paths. Every step prints "ran" or "skipped (reason)" plus a closing table.
  Fails closed to the full fast tier: `--full` / `CI_FULL=1`, no resolvable range, or a change to the gate scripts, lockfile or shared config
  (`PP_FULL_RE`); the live RLS/@smoke tier keeps its own app-path rule. A tree that already passed `gate` (same git TREE sha, clean tracked tree,
  stamp under `.git/ci-gate-pass/`) is not re-run, so `/wt-land` + its push run it once. Heavy steps take one of N machine-wide slots
  (`MAPLE_GATE_SLOTS`, default 2; waiting gates print "waiting for gate slot (k ahead)"; a dead PID frees its slot). New
  `plugin/scripts/prepush/prepush-lib.sh` (+ `test:plugin-prepush`, 40+ checks incl. fail-closed, stamp, slot semaphore) is the reusable part:
  adopters vendor it into their own `ci-local.sh`. `ci:fast|core|full` are unchanged in coverage. The pre-push selection decisions use bash
  builtins only (no `$(...)`/grep/sed): on Windows under load a fork costs seconds and a gate makes ~40 decisions.
  Documented in `docs/quality.md` ("Affected-only pre-push") and the plugin README.
- **gitleaks path allowlists fixed (plugin v0.9.3).** The tree scan used an absolute `--source`, so gitleaks reported absolute file paths and every
  path-anchored allowlist (`^dir/file$`) in a repo's `.gitleaks.toml` silently never matched (the gate flagged fixtures the repo's own scan accepts). It now
  runs from inside the scan copy with `--source .`. `gitleaks.test.mjs` is the regression.

- **Per-entry expiry for decision-backed exceptions (plugin v0.9.2).** Optional `expires` (ISO date, within `reviewed` + `decisionsMaxAgeDays`)
  on an entry in `predeploy-decisions.json`: past it the entry stops excepting its finding and fails the gate as `decision-expired`; the report
  row shows it. For exceptions with a known removal trigger; the allowlist stays reserved. Unit + e2e tests.

- **store-secret.ps1 writes long secrets without leaking them (plugin v0.9.1).** It now calls Win32 `CredWriteW` directly (up to
  2560 bytes) instead of `New-StoredCredential`, which refused values over 512 bytes and printed a truncated copy of the secret in
  its error record. Every failure path prints a fixed message; verification compares stored length only.
- **Snyk preset (plugin v0.9.0).** `preset: "snyk"` makes Snyk Open Source a real blocking gate scanner: `snyk test --all-projects --dev`
  over the clean tree, every severity, `.snyk` ignores removed from the scan copy. The token is read just-in-time from the credential
  store (`options.tokenCredential`) into the snyk child's env only; a missing token/CLI, auth failure or no projects is a finding, never
  a skip. `snyk.test.mjs` uses a fake CLI.

- **Third-party image debt (plugin v0.8.0, D063).** Opt-in `predeploy.imageDebt` (`ownImages`, `file`, `maxDays`): a committed
  `predeploy-image-debt.json` listing each third-party image (exact pin, owner, plan, `due`, snapshot of finding keys). Its
  findings are reported in their own `THIRD-PARTY IMAGE DEBT: N findings across M images, due D` NOT-ZERO block, never counted as
  zero, never in the blocking count. The gate fails on growth (a finding outside the snapshot), a changed digest, findings left after
  `due`, an unlisted third-party pin, our own image listed, an invalid/stale entry, or an uncommitted file; shrink passes and is
  reported as progress. Snapshots grow only via `run.mjs --rebaseline-image-debt` (reviewable diff, due never extended, refuses on a
  failed scan). The stamp binds the file hash; the guard hook asks before editing it; `trivy-image` findings now carry `image`.
  `trivy-image` waits and retries (12 x 15s) when trivy's cache is locked by another process instead of failing the image.
  `--rebaseline-image-debt` scans third-party images only and names the scan failure per image.
  New `imagedebt.test.mjs` (24 tests: growth, due date, shrink, own image, coverage, ref change, rebaseline, stamp binding).

- **Image scan timeout + visible scan failures (plugin v0.7.2).** Trivy's own default timeout is 5 minutes: a large image (CUDA/torch emotion-server) or a loaded machine hit it and the report was silently missing (surfaced only as `no-report`). Scans now get `--timeout` = the image's `timeoutSec` (default 2h) and a missing report is an `image-scan-failed` finding with trivy's last stderr lines.

- **Image build timeout (plugin v0.7.1).** A heavy image (the CUDA/torch emotion-server) exceeded the fixed 30-minute build timeout and surfaced as an empty `image-build-failed`; builds now default to 2 hours, per image `timeoutSec`, and say when they timed out.

- **Third-party image scanning + rule-wide decision entries (plugin v0.7.0, D062).** `trivy-image` accepts
  `{ name, ref }` to pull and scan an image exactly as deployed (the VM runs many third-party images the gate
  never saw). Decision-backed entries may be rule-wide: `scope: "*"` + `maxSeverity` + an exact rule id, for
  advisory noise that belongs to the rule; a worse finding still blocks and the report counts what the entry
  covers. New `trivy-ref.test.mjs` (Docker + network) pulls an EOL alpine and asserts it is scanned.

- **Decision-backed exceptions + checkov fixes (plugin v0.6.0, D061).** A second, permanent exception file
  `predeploy-decisions.json` (`predeploy.decisions`) beside the expiring allowlist: scanner + rule + exact
  `file[#resource]` scope (no wildcards) + a `D###` that must exist in `docs.decisions` + why-it-cannot-be-fixed +
  `reviewed` date. No expiry; the gate fails on a missing decision, a stale scope, an invalid/wildcard entry, an
  uncommitted file, or a review older than `decisionsMaxAgeDays` (default 180, max 365). The report shows them as a
  separate NOT ZERO count with the "essentials only" rule (`decisionExceptions`, `totals.decisionBacked`); stamps bind
  the file's hash and the guard hook asks before editing it. Findings now carry the scanner's `resource` (checkov,
  trivy, osv). Suppressions are flagged unless backed by an entry: `suppression-audit` now also catches
  `eslint-disable`, `.eslintignore`, gitleaks allowlist blocks and knip `ignore*` config, and skips the two exception
  files. **checkov**: the zero-byte `--config-file` rejection is fixed (a `{}` config is written) and is now proven by a new Docker test (`checkov.test.mjs`: checkov runs and fails on a planted public bucket). The test also exposed that a repo `.checkov.yaml` was still auto-loaded next to `--config-file` and could skip rules, so the scan copy now drops checkov/semgrep/trivy/hadolint/shellcheck ignore files. Docs:
  `docs/predeploy-gate.md`.

- **Enforced pre-deploy gate (plugin v0.5.0, D060).** New `predeploy` block in `maple.config.json`
  (schema + validator): a list of checks (`command` local, `preset` built-in scanner, or `github:` remote-only
  with a written reason), zero findings of any severity by default, exceptions only through a committed,
  expiring allowlist (reason, owner, expiry; expired/unused/uncommitted fail). `/predeploy-gate` runs every
  check on the exact commit, writes a stamp bound to sha + config hash + allowlist hash; a `predeploy-guard`
  PreToolUse hook (Bash/PowerShell/Write/Edit) blocks configured deploy commands without a valid stamp and
  blocks tampering with the stamp state; `verify.mjs` lets deploy scripts check the same stamp. Remote leg is one
  `workflow_dispatch` workflow for the candidate sha (template shipped). `doctor` lists missing tools with
  install commands and Docker fallbacks. The aggressive live ZAP scan (full active policy, only guards: no
  real customer credentials, no PSTN calls) is a post-deploy verification whose debt blocks the next deploy.
  Owner-only TTY emergency override, default off. Docs: `docs/predeploy-gate.md`.

- **Quality gate finds `typescript` from the audited repo (plugin v0.4.1).** The installed plugin cache has no node_modules, so the bare `import "typescript"` failed and the gate silently ran as a no-op in every mission. The compiler is now resolved at run time from the audited repo, then the plugin checkout, with a plain error if neither has it.

- **Jev per-function code-quality GATE (plugin v0.4.0, D051).** Ported
  MapleLens's `tools/jev/audit.mjs` per-function audit (extraction via the
  TypeScript compiler API, typed Jev questions, exact/near-duplicate
  detection, severity scoring) into the plugin as the canonical copy —
  `plugin/scripts/jev/audit/{extract,fingerprint,questions,report,config,
  state-dir,gate,run}.mjs`, using this plugin's own Jev client (Pi-first
  routing, DPAPI credential cache), config from the target repo's
  `maple.config.json` `quality.jevAudit` block (new schema key, opt-in —
  `enabled` defaults to false), and cache/report under
  `<repo>/.maplelens/audit/<slug>/` only when that path is gitignored,
  else a per-user plugin-owned state dir. New `--gate` mode audits only
  changed/edited functions and fails when any trips a BLOCKING rule: an
  exact duplicate (deterministic, fails CLOSED), a Jev-confirmed
  near-duplicate (p >= 0.9), a Serious+ security score at confidence >=
  0.6, a can-fail function with no visible error handling (excluding a
  documented best-effort catch), or a Wasteful+ efficiency score —
  everything else is a non-blocking warning. Every Jev-dependent rule
  fails OPEN (prints "quality gate: Jev unavailable, only deterministic
  checks ran" and never blocks on it) while the deterministic duplicate
  rule always still applies; a sensitive/denylisted function is never sent
  to Jev and never blocks. An inline `// jev-audit: accept <rule> —
  <reason>` comment suppresses one rule for one function, visible in code
  review — there is no flag to skip the gate itself. Wired into
  `maple-land.sh` as a landing step after the repo's own CI gate is green
  and before the push, skipped when `quality.jevAudit.enabled` isn't true;
  a new `/quality-gate` command runs it by hand (`--full`/`--report`).
  `docs/decisions.md`/doc-page text is proposed, not applied — see the
  session's task report.

- **jev-model-routing inverted to Pi-first, plus a credential cache (plugin
  v0.3.1, D058).** Owner decision: the default executor is now the
  cheapest — Pi on `gpt-5.6-luna` — whenever Pi is available; Jev only
  escalates (small->luna, medium->terra, big/high-risk/production/security
  ->sonnet/opus) at confidence >= 0.8, and fail-open never lands on opus.
  New `plugin/scripts/jev/ladder.mjs` (`PI_MODEL_LADDER`, `startModelFor()`,
  `nextRung()` for escalating after a failed validation).
  `route.mjs`'s `chooseExecutor()` now returns `{model, kind}` instead of
  `{executor}`. `pi-run.mjs` takes a `model` param, defaults to
  `gpt-5.6-luna`, and gained a `--model`/`--task`/`--prompt` CLI. Also:
  `client.mjs` now caches the OS-credential-store read in a short-TTL
  (`jev.credentialCacheTtlSeconds`, default 300s), DPAPI-encrypted
  per-user file — never the plaintext key on disk — cutting the
  Get-StoredCredential PowerShell round trip roughly in half on a cache
  hit. See `plugin/README.md`'s Jev section.

- **Jev decision-model integration (plugin v0.3.0).** Three new skills —
  `jev-model-routing` (pick `haiku`/`sonnet`/`opus`/`pi` before delegating
  to a sub-agent), `jev-skill-select` (rank the installed skill catalog,
  may say none apply), `jev-search` (post-search sufficiency + next-query
  decisions) — plus a `SubagentStop` hook
  (`plugin/hooks/jev-validate-subagent.mjs`) that judges a sub-agent's
  final report against its task before the main session trusts it, blocking
  once (guarded by `stop_hook_active`, never twice) when Jev is confident
  the work isn't done. Shared client/config/redact/log/validate modules
  under `plugin/scripts/jev/`; a trimmed headless-Pi runner
  (`pi-run.mjs`, ported from MapleLens's `tools/jev/worker-pi.mjs` +
  `worktree.mjs`) backs the `pi` executor. Fail-open everywhere — no
  credential, timeout, or malformed reply falls back to the non-Jev
  default, never an error. New `jev.*` `maple.config.json` key (schema +
  `validate-config.mjs`). See `plugin/README.md`'s "Jev" section, D057.

- **`maple-reap` no longer deletes worktrees it doesn't own.** Reported from
  MapleLens: a session kept a worktree of `main` itself at `.worktrees/main`
  as its merge base; reap treated "under worktrees.root" as ownership, found
  `main` "merged into origin/main" (trivially true), and deleted both the
  worktree and the local `main` branch, taking a running app's build output
  with it. That assumption held while the root was a sibling dir only our
  scripts wrote to; D055 moved it inside the repo, where anyone parks
  worktrees. Pass 1 now reaps only branches matching the naming pattern and
  never `target` / `prodBranch` / `devBranch` (pass 2 guards the same
  branches for prefix-less patterns). The same pass also removed every
  DETACHED worktree unconditionally — dirty trees, and commits reachable from
  no branch — and now removes one only when clean and merged.
  `reap-ownership.test.mjs` rebuilds the incident; against the old script it
  fails 7 of 12, reproducing all four losses.

- **knip survives Windows Application Control.** knip's `oxc-resolver`
  ships an unsigned native module that Windows Application Control refused
  to load ("An Application Control policy has blocked this file"), turning
  the fast tier red and blocking every push on an environment fault rather
  than a finding. `pnpm run knip` now goes through `scripts/run-knip.mjs`,
  which runs the same knip in a `node:24-bookworm` container only when that
  exact error is detected; any other failure and every real finding still
  fail, and a missing Docker fails loud. Its node_modules and pnpm store live
  in a per-repo named volume so the host install is untouched.
  `KNIP_FORCE_CONTAINER=1` exercises the fallback. (The block itself turned
  out to be path-scoped: the same binary loads from the relocated repo.)

- **The standard now reaches the projects that use it (D053).** The
  maple-standard ships as a `directory`-source plugin marketplace, but
  Claude Code does not read that directory live — it COPIES it into
  `~/.claude/plugins/cache/<name>/<version>/`. That cache had been frozen
  at v0.1.0 since 2026-07-27 while the repo moved on to v0.2.0, so every
  adopting project was silently running July's plugin: no `skills/`, and
  none of the six session commands. It went unnoticed because the stale
  `~/.claude/commands` + `~/.claude/skills` duplicates that D051 had
  already superseded were shadowing the plugin's copies. New
  `plugin/scripts/sync-plugin-cache.mjs` content-hashes `plugin/` against
  the cache and re-mirrors on drift (temp-dir + atomic swap, preserves
  `.in_use`, prunes only this plugin's older versions), driven by a
  `~/.claude/settings.json` SessionStart hook — that layer is chosen
  deliberately, since the plugin's own `hooks/hooks.json` ships inside the
  very cache that goes stale and cannot bootstrap itself. `--check` and
  `--force` for manual use; fails open so it can never block a session. The
  shadowing globals were moved to `~/.claude/backups/`, not deleted.

- **Parallel-session worktrees moved inside the repo (D055).**
  `worktrees.root` now defaults to `<repo>/.worktrees` instead of a sibling
  `../<repo>-wt` directory, so a project is one filesystem path and nothing
  lives outside the checkout. The explicit `worktrees.root` override is
  unchanged. `maple_ensure_loop_state_gitignored` was generalized into
  `maple_ensure_gitignored <entry>` (keeping every hard-won edge case: CRLF
  tolerance, the missing-trailing-newline guard that once un-ignored a real
  `.env.local`, and `git commit --only`), and `wt-start` / `wt-preview` /
  `dev-burner` each call it with `.worktrees/` so an adopting repo
  self-heals without `/adopt-standard`. `tsconfig.json`, `eslint.config.mjs`
  and `.dependency-cruiser.cjs` exclude it; vitest, knip, playwright and the
  docs scripts were checked and need no change, their globs already being
  anchored below the repo root.

- **`git clean` double-force is now blocked (bash-guard guard 3).** Moving
  worktrees inside the repo put them within reach of `git clean` for the
  first time. Sandbox-verified: `git clean -xfd` prints `Skipping repository
  .worktrees/<slug>` and is safe, but `-xffd` prints `Removing .worktrees/`
  and takes every worktree with it — including the `node_modules` / `.next`
  junctions pointing at the MAIN checkout's real directories, which a
  recursive delete follows. That is precisely the D012 mechanism that gutted
  a main tree three times in three days. The guard counts force flags across
  short clusters and `--force` (stopping at `--` so a pathspec is not
  miscounted) and blocks at two; single `-f` is untouched.
  `hooks.bashGuard.cleanGuardEnabled=false` opts out.

- **Asking style is inline-first, and enforced (D054).** A modal option menu
  stops the turn and makes the owner arbitrate, so `AskUserQuestion` is now
  the exception rather than the default: ask plainly inline and keep working
  on everything the answer does not block; make the obvious calls instead of
  asking. When a decision genuinely branches, the options must be contrasted
  and exactly one marked `(Recommended)`. `ask-gate.mjs` gained a pure,
  IO-free Tier 0.5 that nudges once per question set when that mark is
  missing — it runs before any doc retrieval and has its own budget, so it
  can never wall off a question that is actually needed.
  `ASK_GATE_MODALITY_DISABLE=1` turns just that tier off.

- **Local Docker stacks are on-demand, never auto-start (D052).** The
  machine had 4 Supabase CLI stacks / 44 containers, all auto-starting on
  every Windows boot, because `supabase start` stamps `restart:
  unless-stopped` on every container it creates — Docker Desktop resurrects
  the whole stack at login regardless of whether the project is being
  worked on. 36 containers ran continuously; 3 (on dead stacks) were stuck
  in permanent restart loops. Two of the four stacks — `maple-pole-local`
  (12 containers) and `supabase` (12 containers, owned only by the legacy
  `Caller/old telnyx MVP` folder) — matched no `config.toml` on disk for
  any live project: 24 of 44 containers, 64% of the load, were orphans.
  Removing them plus `docker image/volume/builder prune -a` reclaimed
  91.4GB (78.48GB images, 2.97GB volumes — dead parallel-session worktree
  DBs like `maple-pole-s4`/`s5`/`s6`/`s8b`, `caller-verify1`/`2`/`3` — 9.93GB
  build cache), landing at 20 containers / 20 images / 5 volumes / 13.58GB.
  The key fix is `docker update --restart=no` on every remaining container:
  while `unless-stopped` is set, a container's `StartedAt` resets on every
  boot, so idle time is unmeasurable; setting `restart=no` both stops the
  auto-start and turns `StartedAt`/`FinishedAt` into a truthful last-used
  timestamp, since a container only starts from then on when someone starts
  it. New standard: no container carries a restart policy other than `no`;
  `dstack up` re-strips the policy `supabase start` re-adds every time;
  stack last-used = `max(StartedAt, FinishedAt)`, idle >14 days flags a
  stack for archiving via the weekly `/docker-audit`, which reports and
  asks — never removes on its own; an orphan (no matching `config.toml`)
  can be archived immediately regardless of age. See [[docker]].

- **IDs are repo-global across worktrees (D050).** `next-task-id.mjs`
  allocated from `max(#T in THIS worktree's tasks.md) + 1` and serialised on
  `docs/tasks.md.lock` — both per-worktree, so two parallel `agent/<slug>`
  sessions each scanned their own branch-local `tasks.md`, each saw `#T41` as
  the highest, and each handed out `#T42`; neither lock could see the other,
  and the collision surfaced only at `/wt-land` with both branches already
  written. The number now comes from `max(counter, live scan) + 1`, where the
  counter is `<git-common-dir>/maple/id-counters.json` (`git rev-parse
  --git-common-dir` resolves to the main checkout's `.git` from inside any
  linked worktree, so all worktrees share one file — inside `.git`, so never
  committed and never conflicting) and the scan walks every worktree from
  `git worktree list --porcelain`, resolving each through its own
  `maple.config.json`. The scan is not redundant: the counter doesn't exist on
  first run, a fresh clone starts empty, and a branch can carry ids allocated
  before this shipped. The `--add` mutex moved to
  `<git-common-dir>/maple/id-alloc-<kind>.lock`, so it serialises across
  worktrees. Read-only queries (bare, `--decision`, `--session`) now report
  the same repo-global number `--add` would allocate — a preview that
  disagreed with the allocator is exactly what a hand-guessing agent copies.
  `--check` stays local-only on purpose: two worktrees both holding `#T7` is
  normal (shared history), so a cross-worktree duplicate scan would be nearly
  all false positives. New `--root <path>` names the worktree explicitly —
  `CLAUDE_PROJECT_DIR` is set once at session start and does not follow a `cd`
  into a worktree, the same trap `resolve-root.mjs` documents. Everything
  fails open: no git, no `git` on PATH, or an unwritable `.git` degrades to
  the old single-worktree behaviour rather than refusing to allocate. New
  `plugin/scripts/docs/lib/id-store.mjs`; escape hatches `MAPLE_ID_STORE_DIR`
  and `MAPLE_ID_SHARED=0`. Verified against a two-worktree scratch repo: 6
  concurrent allocations across both worktrees produced 6 distinct ids,
  `#T`/`D`/`S` all interleave correctly, and both fallback paths still
  allocate.

- **Skills and session commands ship in the plugin (D051).** The plugin had
  no `skills/` directory at all. `credential-manager` lived only in
  `~/.claude/skills/` and `/todo`, `/project-status`, `/session-end`,
  `/represent`, `/review-aspect` only in `~/.claude/commands/` — machine-local,
  unversioned, and invisible both to a second machine and to any project
  adopting the standard. All six now ship in `plugin/skills/` and
  `plugin/commands/`. `credential-manager` was genericized on the way in
  (`<Project>-<Service>-<Purpose>` placeholders instead of one project's real
  target names; the BOM-pipe incident kept as an unattributed cautionary note)
  and is the counterpart to the `deny-credential-paths.mjs` hook — that hook
  blocks reading `.env*`, and blocking without offering a working alternative
  just pushes an agent toward asking the owner to paste the secret into the
  transcript. The three allocator-aware ported commands now call the
  plugin-bundled allocator with `--root` instead of assuming a project-local
  `scripts/next-task-id.mjs`. Plugin bumped to 0.2.0.

- **Worktree teardown no longer deletes through build-output junctions
  (D012).** Root-caused in maple-pole (its D049, 2026-07-30) after three
  gutted-node_modules incidents in three days: Next.js/Turbopack writes
  junctions under a worktree's `.next/node_modules/`
  (`require-in-the-middle-<hash>` / `import-in-the-middle-<hash>` — the
  Sentry require-hook externals) whose targets are the MAIN checkout's real
  `.pnpm` package dirs, and `git worktree remove --force` —
  `maple_remove_worktree`'s first step — follows junctions during its
  recursive delete: it empties the TARGET and leaves the dir
  (sandbox-verified; current MSYS `rm -rf` and `cmd rmdir /s` unlink
  junctions safely). `maple_remove_worktree` now strips every reparse point
  inside the worktree first (new `strip-reparse-points.ps1` — a walk that
  deliberately does NOT descend through links, since Windows PowerShell
  5.1's `-Recurse` follows junctions and would reach the main tree), and
  `_maple_link_dir` rmdir's an existing link instead of `rm -rf`-ing it
  (the maple-preview re-link path). Regression test:
  `plugin/scripts/agent-wt/junction-safety.test.mjs` (junction on Windows,
  symlink on POSIX; asserts the link target's files survive teardown),
  wired as `test:plugin-agent-wt` into fast 6/7 next to the loop-pack
  tests — verified failing against the pre-fix lib (target gutted to 0
  entries) and passing after.

- `/adopt-standard` shakedown fixes from its first real adoption
  (EasyCaller/Caller-development, 10 defects): the "what this command
  writes" summary no longer contradicts step 6's hook-wiring body; step 2
  now documents a non-interactive (`AskUserQuestion`-unavailable) fallback
  that infers/defaults conservatively and records every assumption
  prominently instead of guessing silently; step 1's prod/dev checkout
  heuristic now resolves ROLE from directory-name convention and
  repo-wide branch existence, not from either checkout's current (often
  mid-work, non-stable) HEAD; step 2's checklist now covers
  `worktrees.root`/`worktrees.namePattern` explicitly, including their
  linked-worktree-aware default resolution; `repo.standingLoopBranch`'s
  ask no longer conflates the branch name with whether the loop pack is
  active (`loops.enabled` controls that); `$CLAUDE_PLUGIN_ROOT` resolution
  for an agent invoking the scripts directly (outside a plugin-loaded
  session) is now documented; step 7 now distinguishes a red gate caused
  by this command's own scaffolding from a red gate surfacing genuine
  pre-existing docs debt (report the latter, never silently fix it); and a
  new "Adopting a project with existing docs" section captures the
  real-world lessons.
- `docs/standard-architecture.md`'s canonical `maple.config.json` example
  (models EasyCaller) corrected to match its real layout —
  `prodBranch: "production"` (was the stale `"main"`; EasyCaller has no
  `main` branch) and `lint.roots` reflecting the real `app/src`/`admin/src`/
  `frontend/app` roots (was a generic `src`/`frontend/src` that doesn't
  exist in that project) — plus its step-6 wording aligned with the
  adopt-standard fix above (no per-project hook merge; collision-flagging
  only).
- Fixed `plugin/scripts/docs/lib/preamble.mjs`'s legacy blockquote-preamble
  parser hardcoding bold markdown (`**Audience:**`) as the only recognized
  label form — a real adopting project's identical-structure, non-bold
  preamble (`> Audience: ...`) was silently unrecognized, producing false
  "no anchor" drift-gate warnings. Both forms parse identically now, and a
  legacy page with only `Audience:`/`Authoritative for:` (no `Code:`/
  `Enforced by:`/etc.) correctly counts as anchored, matching the
  frontmatter path's own parity. New standalone tests in
  `plugin/scripts/docs/lib/preamble.test.mjs`.
- Bundled the canonical docs tooling into the plugin (`plugin/scripts/docs/`
  — `check-docs-drift.mjs`, `generate-docs-index.mjs`, `next-task-id.mjs`,
  `doc-search/search.mjs`), config-driven via `maple.config.json` `docs.*`
  so non-template adopters get them without owning copies (#T13). This
  template's own `scripts/*.mjs` are now thin delegates to the bundled
  versions — `package.json` scripts, husky hooks, and CI tiers are
  unaffected.
- Docs system aligned with Google OKF v0.1 (D010): pages carry YAML
  frontmatter (`type`/`title`/`description`/`tags`/`timestamp` +
  `audience`/`authoritative_for`/`code`/`reference_for`); the legacy prose
  blockquote preamble still works but the drift gate now warns on it.
  `docs/index.md`'s Catalog section is generated from each page's
  frontmatter `description` between `<!-- catalog:begin/end -->` markers;
  the gate errors if it goes stale. Both `[[wikilinks]]` and relative
  markdown links to in-docs `.md` files are now validated (external
  http(s) links ignored). All 10 of this template's own `docs/*.md` pages
  migrated to frontmatter as the reference implementation.
- Instantiated from the maple-standard template.
