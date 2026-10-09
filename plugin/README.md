# maple-standard (plugin)

A Claude Code plugin carrying Studio Maple's **stack-agnostic AI-workflow
machinery** — worktree lifecycle, safety hooks, a docs-drift gate executor,
self-healing error triage, and a budget-bounded autonomous "loop pack" — so
any existing project can adopt the standard without cloning the
`maple-standard` template repo. Every project-specific value (branch names,
ports, script paths, error-tracker identity, gate commands) is read from a
per-project `maple.config.json`, with sane defaults for a typical
single-package project.

**Status: skeleton.** Commands ported from a production reference (`wt-*`,
`sync-docs`, `heal`) carry real structure and logic. The loop pack
(`sweep-errors`, `burn-backlog`, `sweep-quality`, `detect-drift`,
`dev-burner`) is now implemented per `docs/loop-pack.md` (docs/tasks.md
#T8) — see "The loop pack" below. `adopt-standard` is a real bootstrap. See
"Gaps" below for what's not done yet.

## What you get

| Component | What it does |
|---|---|
| `/wt-start`, `/wt-land`, `/wt-preview`, `/wt-reap` | Isolated parallel-session git worktrees + a single merge semaphore (`/wt-land`) so concurrent Claude sessions never collide on the shared tree. |
| `/sync-docs` | The docs-drift **executor** — semantic reconciliation of `docs/` against code, backed by the bundled structural drift script (`plugin/scripts/docs/check-docs-drift.mjs` — see "Bundled docs tooling" below), OKF v0.1 frontmatter-aware per D010. |
| `/heal` | Error-tracker-driven self-healing: fetch, cluster, triage, fix, and verify unresolved issues through a 5-tier ladder before marking them resolved. |
| `/adopt-standard` | Bootstrap: validates + stamps `maple.config.json`, scaffolds canonical `docs/` files + `CLAUDE.md` if missing, generates the docs index, checks no project hook duplicates the plugin's, verifies the docs gate + a CI tier before declaring done. |
| `/sweep-errors`, `/burn-backlog`, `/sweep-quality`, `/detect-drift`, `/dev-burner` | The **loop pack** — budget-bounded autonomous loops orchestrated by `/dev-burner` under `/loop`, working in an isolated standing `dev-burner` worktree that never self-merges. See "The loop pack" below. |
| `/todo`, `/project-status`, `/session-end`, `/represent`, `/review-aspect` | The **session commands** — open-task list, status board, session close-out (log + tasks + docs gate), a plain-English "where are we" orientation, and a single-aspect code review. All docs-shape-agnostic and allocator-aware; previously machine-local under `~/.claude/commands/`, now bundled so every adopting project gets them. |
| `/predeploy-gate` | The **enforced pre-deploy gate** (D060): zero-findings checks (local scanners + one remote workflow), expiring allowlist + permanent decision-backed exceptions (D061, essentials only) + dated, shrink-only third-party image debt (D063), sha-bound stamp, `predeploy-guard` hook that blocks deploy commands without a stamp, `doctor`, run-workspace pruning (`run.mjs prune`, `predeploy.runs`, `predeploy.minFreeGB`, D068), the aggressive post-deploy live ZAP scan, and the stack-exposure standard (D072, v0.14.0: `stack-exposure` preset + anonymous live probes, required unless opted out by a decision). See `docs/predeploy-gate.md`, `docs/stack-exposure.md`. |
| `plugin/scripts/prepush/prepush-lib.sh` | The **affected-only pre-push gate toolkit** (v0.10.0): source it from a project's `ci-local.sh` to select checks from the push range (`pp_want` / `pp_want_graph` / `pp_list_*`, one "ran / skipped (reason)" line per step), fail closed to FULL (no range, `--full`, gate scripts / lockfiles / shared configs), keep a tree-sha-bound pass stamp under `.git/ci-gate-pass/` so `/wt-land` + the push it makes run the gate once, keep per-checkout caches, and cap concurrent heavy gates machine-wide with a stale-safe slot semaphore (`MAPLE_GATE_SLOTS`, default 2). Selection is builtins-only (a fork costs seconds under load). Companion `install-hooks.mjs` makes the git hooks fail closed in every worktree (absolute `core.hooksPath` into the git common dir; see `docs/quality.md`). Vendor the file into a project (EasyCaller: `scripts/lib/prepush-lib.sh`); `node plugin/scripts/prepush/run-tests.mjs` proves the fail-closed rules. |
| `plugin/scripts/gate/`, `plugin/scripts/agent-wt/maple-queue.sh` | **Gate v2** (D066, v0.12.0): `heavy-run.mjs` (the scheduled heavy tier in a temporary worktree: stamp on green, failure report otherwise), `gate-cli.mjs` / `gate-state.mjs` (verified `MAPLE_GATE_SKIP` reasons, the gate-debt ledger `gate-debt.jsonl`, heavy stamps `heavy-pass/<sha>.json`, the production-promotion requirement used by `predeploy` verify), `run-suite.mjs` (unit vs `*.integration.test.*` split), `find-bash.mjs` (Git Bash, never WSL); the **landing queue** behind `/wt-land` (FIFO batch, one gate, bisect on red, locks never stolen from a live pid); `plugin/scripts/docs/check-docs-touched.mjs` (non-blocking docs-sync warning at landing). See `docs/quality.md` and "Gate v2 - consumer migration" below. `pnpm test:plugin-gate`, `pnpm test:plugin-integration`. |
| `plugin/skills/credential-manager` | The **credential skill** — read secrets from the OS credential store (Windows Credential Manager) just-in-time for local commands, instead of reading `.env*` (which `deny-credential-paths.mjs` blocks anyway) or asking the owner to paste a value. Pairs with that hook: the hook closes the wrong path, the skill supplies the right one. |
| `plugin/hooks/guards/dep-version-guard.mjs`, `plugin/scripts/deps/` | **Dependency freshness** (D064, v0.11.0): agents write versions from memory, so new deps land outdated. A guard (inside the PreToolUse dispatcher) denies hand-writing a dependency (added or re-specced) in any `package.json` — use `pnpm add <pkg>`; the bash guard denies `pnpm/npm/yarn/bun add pkg@<version>` behind the latest major (0.x: minor; registry lookup, fail-open with a warning); `plugin/scripts/deps/check-dep-freshness.mjs` is the diff-scoped **ci:fast** gate (every dep added/changed vs the target branch must be at the latest major; honors pnpm `minimumReleaseAge`; unreachable registry fails). Exceptions: `deps.exceptions[]` in `maple.config.json`, each citing a `D###` that exists in the decisions ledger. Consumers wire the gate into their fast tier via `/adopt-standard` (step 6b). `node plugin/scripts/deps/run-tests.mjs` (`pnpm test:plugin-deps`). |
| `plugin/hooks/hooks.json` | **Hooks v2 (D065, v0.12.0)** — three registrations, nothing per-turn: ONE PreToolUse dispatcher `plugin/hooks/guard.mjs` (matcher `Bash|PowerShell|Read|Grep|Glob|Write|Edit|MultiEdit` plus only the mutating Supabase MCP tool names, so read-only MCP calls spawn nothing) that lazy-loads only the guard modules a tool needs from `plugin/hooks/guards/` and runs them in-process (first deny wins; the no-op path spawns no child process), `scrub-secrets` (PostToolUse: Bash/PowerShell/Read/Grep), and the `SubagentStop` validator. Guards: **link-guard** (no install into / recursive delete through a linked node_modules), **bash-guard** (cwd anchor with `/c/...`, `C:/...`, `C:\...` normalised; foreground push; double-force `git clean`; install freshness), **hook-bypass** (`--no-verify`, `git commit -n`, `core.hooksPath` via `-c` or `git config`, `HUSKY=0`, `--no-gpg-sign`, `commit.gpgsign=false`), **deny-credential-paths** (Read/Grep/Glob paths, plus ANY shell verb naming `.env`, `.env.*`, `.dev.vars`, `.credentials.json`, ssh keys, private `.pem`; `*.example|sample|template` exempt), **deploy-guard** (the D060 stamp gate: a built-in baseline `wrangler deploy|pages deploy`, `supabase db push|functions deploy`, `terraform apply`, `vercel --prod` that config can only ADD to, a `git push` to `repo.prodBranch`, gate-state tampering, fail-closed on its own deadline), **mcp-guard** (mutating Supabase MCP tools only on a listed `supabase.devProjectRefs` project; D067: Supabase `list_projects`/`list_organizations` are answered with the repo refs, since the connector lists only one org), **worktree-guard** (`git worktree add` only under `<main-root>/.worktrees/` or `.claude/worktrees/`, never nested), **loop-budget-guard** (cheap fs sentinel first), **dep-version-guard** (D064). All of them read Bash and PowerShell through one quote/heredoc-aware tokenizer (`guards/shell.mjs`), so a commit MESSAGE that mentions a flag is not blocked. Removed: dirty-tree-guard, docs-sync-reminder, decision-reminder, parallel-session-warn, ask-gate. Tests: `node plugin/scripts/hooks/run-tests.mjs` (`pnpm test:plugin-hooks`); `plugin/scripts/hooks/check-hook-wiring.mjs` (fast tier) fails a project that registers a copy. |

## Gate v2 - consumer migration (D066, plugin v0.12.0)

D066 moves the expensive checks out of every landing into a batched **heavy** tier, keeps production promotion
strict, and makes the landing queue safe. A project that adopted the standard (VeHagita, EasyCaller/Caller, MapleLens,
Nekuda) migrates once; nothing here can be skipped without leaving the production deploy guard red.

**1. Plugin scripts.** Update the plugin (version 0.12.0). The gate scripts live in `plugin/scripts/gate/`
(`gate-cli.mjs`, `gate-state.mjs`, `heavy-run.mjs`, `run-suite.mjs`, `find-bash.mjs`); the landing queue in
`plugin/scripts/agent-wt/maple-queue.sh`; `plugin/scripts/docs/check-docs-touched.mjs`.

**2. `ci-local.sh` (every project has a copy of the template's).** Re-copy the template's `scripts/ci-local.sh` and
re-apply the project's own steps, or port the changes by hand: three tiers `fast | gate | heavy` (drop `core`/`full`);
`gate` has **no live tier and no Docker**; add the heavy tier (full fast + integration suites + stack-on-demand + live
RLS/E2E + Jev audit + stamp via `node <plugin>/scripts/gate/gate-cli.mjs stamp`); replace `SKIP_LIVE_GATE` handling with
`gate_skip <step>` (calls `gate-cli.mjs skip`); move single-tool configs (`knip.json*`, `.dependency-cruiser*`,
`.gitleaks.toml`) out of `PP_FULL_RE` into their own steps; set `PLUGIN_DIR` (or `MAPLE_PLUGIN_DIR`) so the script finds
`scripts/gate/`. Print the docs-touched warning at the end of `gate`.

**3. `prepush-lib.sh` (vendored copies, e.g. EasyCaller `scripts/lib/prepush-lib.sh`).** Replace with the plugin's
canonical file (keep byte-identical): it adds `pp_sleep` (sandbox-safe sleep), the never-rob-a-live-pid lock rule
(`PP_LOCK_GRACE` replaces `PP_LOCK_TTL`) and per-step timings in `pp_summary`. Vendored copies that still call `sleep`
crash under the Claude Code Bash sandbox.

**4. `ci-local.ps1`.** Replace with the template's shim (finds Git Bash, execs `ci-local.sh`); delete the PowerShell
mirror logic. `package.json`: `ci:fast|gate|heavy` -> `node scripts/run-gate.mjs <tier>` (copy `scripts/run-gate.mjs`), `ci:*:win` -> the shim;
remove `ci:core` / `ci:full`.

**5. `maple.config.json`.** Add `ci.tiers.heavy` (e.g. `"pnpm ci:heavy"`); keep `ci.prePushTier: "gate"`. `quality.jevAudit`
now runs in the heavy tier, not in `/wt-land`. `worktrees.lock.ttlSeconds` is ignored. Production/dev branch keys unchanged.

**5b. Isolated CI stack (D071, plugin v0.13.7).** The heavy tier must not run against a dev stack. Add `ci.stack` to `maple.config.json`:
`"ci": { ..., "stack": { "portBase": <free 10-port block> } }` (optional `projectId`, default `<project_id in supabase/config.toml>-ci`; optional
`exclude`: containers to skip, default `studio,imgproxy,logflare,vector,mailpit`). Pick a block outside the dev block and outside the reserved
ranges (`netsh interface ipv4 show excludedportrange protocol=tcp`), then have the owner reserve it (`netsh int ipv4 add excludedportrange
protocol=tcp startport=<portBase> numberofports=10`, elevated). Re-copy the template's `scripts/ci-local.sh` (live tier: `ensure_ci_stack` /
`stop_stack_if_ours`, `CI_STACK` = `<plugin>/scripts/gate/ci-stack.mjs`) and `scripts/check-types-fresh.mjs` (honours `CI_SUPABASE_WORKDIR`).
Point the project's Supabase tests and Playwright at `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_DB_URL` /
`E2E_SUPABASE_URL` (what `ci-stack.mjs env` exports) instead of hardcoded dev ports. Without `ci.stack` heavy still runs against the dev stack,
with a warning. VeHagita: `portBase` next to its 5532x block that is free (e.g. 5542x). EasyCaller/Caller: keep `ci.stack.projectId: "ezcall-ci"`,
`portBase: 58420`, delete `scripts/ci-supabase.mjs` and its lock plumbing in favour of the plugin's `ci-stack.mjs up|env|down` (the plugin's lock owner is
the gate run: `--owner-pid`). `env` output carries keys: eval it, never print it.

**6. Husky.** Re-copy `.husky/pre-commit` (staged-file lint + migration naming, no tsc) and `.husky/pre-push` (messages).

**7. Test suites.** Rename slow suites to `*.integration.test.*` and have their runner use `plugin/scripts/gate/run-suite.mjs`
(or equivalent): the unit set runs in fast/gate, the integration set only in heavy.

**8. Playwright.** `webServer` on a gate-only port (`E2E_PORT`, default 3100), `reuseExistingServer: false`,
`E2E_SKIP_BUILD=1` honoured; never kill anything on 3000.

**9. Supabase ports.** If the project's `supabase/config.toml` still uses the CLI's `5432x` defaults and Windows reserves them,
pin every port to an unreserved block (template: 5632x) and update the references (tests, workflow `--db-url`, `.env.example`).

**10. Vitest.** Optional speed-up: `node` + `jsdom` projects.

**11. Schedule + stamp.** Register `heavy-run.mjs` with Task Scheduler (owner-run, see `docs/quality.md`) and run
`pnpm ci:heavy` once so the first production promotion has a stamp for HEAD. `predeploy verify` now refuses a deploy without
a green heavy stamp for HEAD and with unpaid gate debt. Replace any `SKIP_LIVE_GATE=1` habit with
`MAPLE_GATE_SKIP=docker-unavailable` (verified, recorded, paid by the next green heavy run).

## How updates propagate

Claude Code does **not** read a `directory`-source marketplace live — on
install (and marketplace refresh) it copies `plugin/` into a versioned
cache (`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`), and
every session reads that copy, not this repo. Editing `plugin/` here has no
effect anywhere else until something re-runs the copy.

`plugin/scripts/sync-plugin-cache.mjs` is that "something". It's wired as
a `SessionStart` hook in `~/.claude/settings.json` (not in this plugin's
own `hooks/hooks.json` — that file lives IN the cache and can't bootstrap
it), so it runs at the start of every session on this machine. It compares
a content hash of `plugin/` against a manifest it wrote into the cache
last time, and re-mirrors the tree only when they differ (new version, or
an edit without a version bump) — a few hundred ms no-op the rest of the
time. It self-heals the registered marketplace path if the repo has moved.

```
node plugin/scripts/sync-plugin-cache.mjs           # sync now (normally automatic via the hook)
node plugin/scripts/sync-plugin-cache.mjs --check   # report drift only, change nothing (non-zero exit if stale)
node plugin/scripts/sync-plugin-cache.mjs --force   # re-sync even if the content hash already matches
```

## Install

1. **Add the marketplace** (once per machine, from this repo):
   ```
   /plugin marketplace add C:\Projects\Maple-Standard
   ```
   (or a git remote URL once this repo is pushed somewhere Claude Code can
   reach — `owner/maple-standard` on GitHub, etc.)
2. **Enable the plugin per project**:
   ```
   /plugin install maple-standard@maple-standard
   ```
   Run this from inside the project you want the standard active in. It
   adds the plugin's commands + hooks to that project's Claude Code session.
3. **Bootstrap the project**: run `/adopt-standard` once to stamp
   `maple.config.json` and scaffold `docs/`. Everything else degrades
   gracefully without it (defaults apply), but tuned config is what makes
   the worktree/gate/tracker commands actually match your project.

## `maple.config.json` — full schema

Lives at the adopting project's root. **Every key is optional except
`project.name`/`project.slug`** — omit anything else and its default
applies. **Canonical** per `docs/standard-architecture.md`'s
`maple.config.json` schema (`project`/`repo`/`worktrees`/`docs`/`ci`/
`lint`/`sizeCaps`/`errorTracker`/`loops`) — one key set, no aliases
(reconciled `docs/tasks.md` #T11; see "Schema reconciliation" below for
what changed). The formal shape lives at
`plugin/schema/maple.config.schema.json`; validate any config against it
with:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs" [path/to/maple.config.json]
```

Every command/script that reads `maple.config.json` and hits something it
can't make sense of (parse failure, an unknown key, a wrong-typed value)
points here rather than guessing.

Where a script genuinely needs an operational parameter the canonical
top-level blocks don't spell out (e.g. worktree lock timing, the preview
dev-server command), it's nested **under the matching canonical top-level
key** (`repo.*`, `worktrees.*`, `docs.*`) — never a new sibling block. Those
extensions are marked below.

### `project.*` — identity, read everywhere

| Key | Default | Notes |
|---|---|---|
| `project.name` | **required** | human-readable name |
| `project.slug` | **required** | `^[a-z0-9-]+$` — substituted into `worktrees.namePattern`'s `<slug>` placeholder |

### `repo.*` — used by `/wt-start`, `/wt-land`, `/wt-preview`, `/wt-reap`, `/adopt-standard`, the loop pack

| Key | Default | Notes |
|---|---|---|
| `repo.prodCheckout` | **none** | dual-checkout only (D008) — the prod checkout's path |
| `repo.devCheckout` | **none** | dual-checkout only — the persistent dev checkout's path |
| `repo.prodBranch` | **none** | e.g. `"main"` |
| `repo.devBranch` | **none** | e.g. `"development"` — if set, this is the `wt-*` integration branch (dual-checkout wins over prodBranch, D008); the loop pack's standing worktree always targets this checkout |
| `repo.standingLoopBranch` | `"dev-burner"` | the branch `/dev-burner` works on (see [[loop-pack]]) |
| `repo.remote` | `"origin"` | plugin extension (nested under the canonical `repo` block — not in the schema's illustrative example, needed by every `wt-*` script) |

No `repo.devBranch`/`repo.prodBranch` configured? The integration/target
branch falls back to the origin's detected default branch
(`git symbolic-ref refs/remotes/origin/HEAD`), then `"main"`.

### `worktrees.*` — used by `/wt-start`, `/wt-land`, `/wt-preview`, `/wt-reap`

| Key | Default | Notes |
|---|---|---|
| `worktrees.root` | `".worktrees"` | dir inside the repo holding all worktrees, gitignored (`/wt-start` self-heals the `.gitignore` entry); relative paths resolve against the repo root |
| `worktrees.namePattern` | `"agent/<slug>"` | `<slug>` is substituted; replaces the old invented `branchPrefix` key — prefix/suffix around the placeholder are derived from this pattern |
| `worktrees.nodeModulesDirs` | `["."]` | plugin extension — dirs (repo-root-relative) whose `node_modules` gets junction/symlinked into a new worktree |
| `worktrees.envFiles` | `[]` | plugin extension — gitignored env files (repo-root-relative) hardlinked into a new worktree |
| `worktrees.freshDepsCommand` | `"npm ci"` | plugin extension — run instead of linking, with `/wt-start --fresh-deps` |
| `worktrees.preview.port` | `8080` | plugin extension — the one shared preview dev-server port |
| `worktrees.preview.workdir` | `"."` | dir (relative to the worktree) the preview command runs in |
| `worktrees.preview.command` | `"npm run dev -- --port {port} --host 127.0.0.1"` | `{port}` substituted |
| `worktrees.preview.logFile` | `".preview-dev.log"` | relative to the preview worktree |
| `worktrees.lock.ttlSeconds` | — | **ignored since D066** — a land lock is never stolen from a live pid (stale only when its holder pid is dead); still accepted by the schema |
| `worktrees.lock.waitSeconds` | `300` | total queue-wait before `/wt-land` gives up — kept well under a typical Bash-call timeout |
| `worktrees.lock.pollSeconds` | `5` | lock poll interval |
| `worktrees.reap.staleHours` | `24` | idle threshold for `/wt-reap --force` |

### `ci.*` — used by `/wt-land` (the gate), `/adopt-standard`, `/sweep-quality`

| Key | Default | Notes |
|---|---|---|
| `ci.tiers.<name>` | **none** | shell command string run as the gate for that tier (conventionally `fast`/`gate`/`heavy`) — **required** for any tier you invoke; `/wt-land` refuses to land ungated rather than guess. Replaces the old invented `worktree.gate.tiers.<name>` key. |
| `ci.prePushTier` | `"gate"` | which tier `/wt-land` runs with no `--tier`. Replaces the old `worktree.gate.defaultTier`. |
| `ci.stack.portBase` | **none** (stack off) | **enables the isolated heavy-tier Supabase stack (D071)**: the 10-port block `portBase..portBase+9` holds every port of the throwaway stack; must not overlap the dev block or a reserved range |
| `ci.stack.projectId` | `<supabase/config.toml project_id>-ci` | the throwaway stack's project id (containers `supabase_*_<id>`, volume `supabase_db_<id>`); must differ from the dev id |
| `ci.stack.exclude` | `["studio","imgproxy","logflare","vector","mailpit"]` | containers `supabase start -x` skips in the CI stack |

### `lint.*` / `sizeCaps.*` — reserved, not yet read by any bundled plugin code

Both blocks are schema-legal (`plugin/schema/maple.config.schema.json`) and
validated (`validate-config.mjs`), but **no script or hook in this plugin
reads them today** — being honest about that here rather than implying a
consumer exists. They're reserved for **this template's own** project-local
enforcement, not the plugin: `lint.roots`/`lint.maxWarnings` for a future
generic lint-runner equivalent to this repo's own `eslint.config.mjs`, and
`sizeCaps.hook`/`.component`/`.service`/`.route` for a future generic
equivalent to the removed `size-warning` hook (D065; size caps are ESLint-enforced). Wiring either up is
real, separate work — not invented ad hoc here — should a project need a
config-driven version of those checks:

| Key | Default | Notes |
|---|---|---|
| `lint.roots` | **none** | array of path-shaped strings — reserved |
| `lint.maxWarnings` | **none** | non-negative integer — reserved |
| `sizeCaps.hook` / `.component` / `.service` / `.route` | **none** | positive integers — reserved |

### `docs.*` — used by `/sync-docs`, `/adopt-standard` and the bundled docs tooling

| Key | Default | Notes |
|---|---|---|
| `docs.root` | `"docs"` | the wiki folder (flat or nested) |
| `docs.index` | `"docs/index.md"` | the catalog page |
| `docs.decisions` | `"docs/decisions.md"` | the decision ledger |
| `docs.tasks` | `"docs/tasks.md"` | the task ledger |
| `docs.gaps` | `"docs/gaps.md"` | owner-flagged gaps |
| `docs.log` | `"docs/log.md"` | session history |
| `docs.docsIndexJson` | `"docs/.docs-index.json"` | machine-readable doc -> code anchor map, checked by the drift gate |
| `docs.changelog` | `"CHANGELOG.md"` | plugin extension (nested under the canonical `docs` block) — used by `/sync-docs` |
| `docs.ephemeralPaths` | `[]` | plugin extension — doc-relative paths not owned by code — skipped by `/sync-docs` ownership resolution |

Every script under `plugin/scripts/docs/` reads this one key set — no aliases
(this used to be two drifted-apart sets; see "Schema reconciliation" below).
There is no `docs.searchScript` key (doc search is the plugin's bundled
`plugin/scripts/docs/doc-search/search.mjs`) and no `docs.idAllocatorScript`
key (the allocator is the bundled `plugin/scripts/docs/next-task-id.mjs`).

### Bundled skills (`plugin/skills/`)

| Skill | What it does |
|---|---|
| `credential-manager` | Reads secrets from the OS credential store (Windows Credential Manager; Keychain / `secret-tool` noted for macOS / Linux) just-in-time for local commands — deploys, migrations, CLI auth, Docker env injection. Documents the two safe delivery patterns (process-scope env var, UTF-8-no-BOM temp file) and the PowerShell 5.1 pipe trap that silently BOM-corrupts a piped secret. |

This is the other half of the `deny-credential-paths` guard. That hook
blocks the wrong path (`.env*`, `.dev.vars`, `~/.ssh/id_*`); the skill
supplies the right one. Blocking a read without offering a working
alternative just pushes an agent toward asking the owner to paste the value
into the transcript — the outcome the block existed to prevent.

The skill ships with `<Project>-<Service>-<Purpose>` placeholder target
names, not one project's real catalog. An adopting project documents its own
catalog in its docs (conventionally `docs/quality/secrets-handling.md`).

### Bundled docs tooling (`plugin/scripts/docs/`) — #T13

Canonical, generalized implementations of the four scripts a project's docs
gate needs, so a non-template adopter (VeHagita, EasyCaller) gets them for
free instead of owning its own copies:

| Script | What it does |
|---|---|
| `check-docs-drift.mjs` | The structural docs-drift gate — see its own header comment for the full ERROR/WARN inventory. `--fix` regenerates the index + catalog. |
| `generate-docs-index.mjs` | Walks `docs.root`, emits `docs.docsIndexJson`, and maintains the generated Catalog block in `docs.index` (see "OKF v0.1 frontmatter" below). |
| `next-task-id.mjs` | Collision-free `#T`/`D`/`S` id allocator — **repo-global across worktrees** (see below). Depended on by `/todo`, `/session-end`, `/project-status`, `/sync-docs`, and this template's own `pnpm next-id`. |
| `lib/id-store.mjs` | The shared high-water mark the allocator reads: a counter in the git common dir plus a live scan of every worktree's docs file. |
| `doc-search/search.mjs` | BM25 doc search (`node scripts/doc-search/search.mjs "query"`) — no config key. |

All four are plain Node, zero new dependencies, and read this **canonical**
`docs.*` key set (via `plugin/scripts/docs/lib/config.mjs`), with defaults
matching this template's own flat `docs/` layout — so they work with **no**
`maple.config.json` present at all:

| Key | Default | Read by |
|---|---|---|
| `docs.root` | `"docs"` | all four |
| `docs.index` | `"docs/index.md"` | check-docs-drift, generate-docs-index |
| `docs.tasks` | `"docs/tasks.md"` | all four |
| `docs.decisions` | `"docs/decisions.md"` | check-docs-drift, next-task-id |
| `docs.log` | `"docs/log.md"` | check-docs-drift, next-task-id, doc-search |
| `docs.gaps` | `"docs/gaps.md"` | check-docs-drift, doc-search |
| `docs.docsIndexJson` | `"docs/.docs-index.json"` | check-docs-drift, generate-docs-index |

This template's own `scripts/check-docs-drift.mjs` / `generate-docs-index.mjs`
/ `next-task-id.mjs` / `doc-search/search.mjs` are now thin delegates to
these bundled versions (same repo, so a relative import just works) — the
template's `package.json` scripts, husky hooks, and CI tiers are unaffected.

#### Repo-global IDs across worktrees

`next-task-id.mjs` used to allocate from `max(ids in THIS worktree's
tasks.md) + 1` and lock on `docs/tasks.md.lock`. Both are per-worktree, so
two parallel `/wt-start` sessions each scanned their own branch-local
`tasks.md`, each saw `#T41` as the highest, and each handed out `#T42` —
with neither lock aware of the other. The collision only surfaced at
`/wt-land`, once both branches were already written.

IDs are now **repo-global**. The allocated number is one past the highest of:

1. a **counter** at `<git-common-dir>/maple/id-counters.json`. `git rev-parse
   --git-common-dir` resolves to the *main* checkout's `.git` from inside any
   linked worktree, so every worktree reads and writes the same file. It's
   inside `.git`, so it is never committed, never merges, and never conflicts;
   machine-local is the correct scope, because worktrees are.
2. a **live scan** of every worktree's docs file (`git worktree list
   --porcelain`, each worktree resolved through its own
   `maple.config.json`). The counter alone isn't enough — it doesn't exist on
   first run, a fresh clone starts empty, and a branch can carry ids allocated
   before this shipped.

The `--add` mutex moved to `<git-common-dir>/maple/id-alloc-<kind>.lock`, so
it now serialises across worktrees rather than within one. Read-only queries
(`next-task-id.mjs`, `--decision`, `--session`) report the same repo-global
number `--add` would allocate — a preview that disagreed with the allocator
is worse than no preview, since it's exactly what a hand-guessing agent
copies.

`--check` stays **local-only** on purpose: two worktrees both holding `#T7`
is normal (they branched from a main that already had it), so a
cross-worktree duplicate scan would be nearly all false positives. The
cross-worktree guarantee comes from allocation, not from after-the-fact
detection.

Everything fails **open**: outside a git repo, without `git` on PATH, or with
an unwritable `.git`, allocation degrades to the old single-worktree
behaviour rather than refusing. Losing the shared counter costs
collision-freedom across worktrees — exactly where you already were — it must
never cost you the ability to file a task.

| Flag / env | Effect |
|---|---|
| `--root <path>` | Name the worktree explicitly. Pass it: `CLAUDE_PROJECT_DIR` is set once at session start and does **not** follow a `cd` into a worktree (same trap `plugin/scripts/loops/resolve-root.mjs` documents). Any `maple-lib.sh` script already has `$MAPLE_REPO_ROOT`. |
| `MAPLE_ID_STORE_DIR` | Use this dir for the counter + lock instead of the git common dir (tests; also an escape hatch for a read-only `.git`). |
| `MAPLE_ID_SHARED=0` | Disable the shared store — behave exactly as before this existed. |

#### OKF v0.1 frontmatter (docs/decisions.md D010)

Each doc page's preamble may be YAML frontmatter — reserved fields `type`,
`title`, `description`, `tags`, `timestamp`; this project's custom fields
`audience`, `authoritative_for`, `code` (the owned-paths list the drift gate
existence-checks — replaces the prose `**Code:**` anchor), `reference_for`
(replaces `**Reference for:**` — descriptive, never existence-checked) — or
the legacy prose blockquote preamble, which still works but gets a WARN so
migration pressure exists. `generate-docs-index.mjs` builds the Catalog
block in `docs.index` (between `<!-- catalog:begin -->` / `<!-- catalog:end
-->` markers) from each page's frontmatter `description`; `check-docs-
drift.mjs` errors if that block goes stale. See `plugin/scripts/docs/lib/
preamble.mjs` and `frontmatter.mjs` for the parser and its documented
limits (flat `key: value` + inline `[a, b]` arrays only — no new
dependency, not a general YAML parser).

### `errorTracker.*` — used by `/heal` (#T9, not yet implemented)

| Key | Default | Notes |
|---|---|---|
| `errorTracker.provider` | `"sentry"` | `"sentry"` \| `"maplelens"` — canonical name, replaces the old `errorTracker.kind` |
| `errorTracker.endpoint` | `null` | Sentry: region URL. maplelens: API base URL. |
| `errorTracker.readTokenRef` | `null` | credential-manager reference, never a literal token |
| `errorTracker.writeTokenRef` | `null` | credential-manager reference, never a literal token |
| `errorTracker.sentryProject` | `null` | Sentry org/project identity (folds the old separate `errorTracker.org` + `.project` keys into this one canonical field) |
| `errorTracker.livePreviewUrl` | plugin extension, **none** | base URL for the T3/T4 live-verification tiers below |
| `errorTracker.query` | plugin extension, `"is:unresolved"` | overridden by `/heal`'s `$ARGUMENTS` |

`/heal`'s own T1-T5 fix-verify ladder (pre-commit checks, push+CI-watch,
deploy-URL polling, a browser check, a post-deploy tracker recheck) is
namespaced under `errorTracker.verification.*` — **not** `ci.tiers.*`,
which is a different concept (the named `wt-land` gate tiers,
`fast`/`gate`/`core`/`full`). An earlier draft of this table nested both
ladders under the same `ci.tiers.*` path, a real key collision found and
fixed during #T11's reconciliation pass:

| Key | Default | Notes |
|---|---|---|
| `errorTracker.verification.t1` | `["npx eslint --cache .", "npx tsc --noEmit", "npm run build"]` | pre-commit commands, run in order |
| `errorTracker.verification.t2.pushCommand` | `"git push origin HEAD"` | |
| `errorTracker.verification.t2.ciWatchCommand` | `""` (tier skipped if empty) | e.g. `"gh run watch"` |
| `errorTracker.verification.t3.deployUrlTemplate` | `""` (tier skipped if empty) | `{livePreviewUrl}` / `{page}` / `{sha}` substituted |
| `errorTracker.verification.t3.waitSeconds` | `20` | poll interval waiting for the deploy to flip |
| `errorTracker.verification.t4.enabled` | `true` | browser console/network check |
| `errorTracker.verification.t5.waitMinutes` | `8` | wait before the post-deploy tracker recheck |

### `hooks.bashGuard.*` — used by `plugin/hooks/guards/bash-guard.mjs`

| Key | Default | Notes |
|---|---|---|
| `hooks.bashGuard.cwdGuardEnabled` | `true` | blocks bare `npm`/`npx`/`yarn`/`pnpm` without an anchoring `cd` |
| `hooks.bashGuard.pushGuardEnabled` | `true` | blocks a foreground `git push` without `run_in_background`/a long timeout |
| `hooks.bashGuard.pushGuardMinTimeoutMs` | `600000` | minimum explicit timeout that satisfies the push guard |
| `hooks.bashGuard.cleanGuardEnabled` | `true` | blocks `git clean` with double force (deletes nested worktrees) |
| `hooks.bashGuard.linkGuardEnabled` | `true` | `plugin/hooks/guards/link-guard.mjs`: blocks `npm|pnpm|yarn|bun` installs (`ci`, `install`, `add`, `remove`, `update`, `prune`, ...) in a dir whose `node_modules` (or a workspace member's) is a junction/symlink, and `rm -r` / `Remove-Item -Recurse` / `rmdir /s` / `rimraf` on a path inside one. Worktrees link node_modules to the main checkout; `npm ci` empties the dir it installs into, so it would wipe the main install (EasyCaller 2026-10-09). The deny names the safe alternatives: install in the owning checkout, or `cmd //c rmdir <link>` first. |

### `supabase.*` — used by `plugin/hooks/guards/mcp-guard.mjs` (D065)

| Key | Default | Notes |
|---|---|---|
| `supabase.devProjectRefs` | `[]` | project refs of DEVELOPMENT Supabase projects. Mutating Supabase MCP tools (`apply_migration`, `execute_sql` unless provably read-only, `deploy_edge_function`, `merge_branch`, `reset_branch`, `rebase_branch`, `delete_branch`, `pause_project`, `restore_project`) are allowed only for a ref listed here. An unlisted ref is treated as production and denied. |
| `supabase.prodProjectRefs` | `[]` | project refs of PRODUCTION projects, always denied (a sharper message than "unlisted"). A ref may not be in both lists. |

### `predeploy.deployGuard.patterns` (D065)

The deploy guard always applies a built-in baseline (wrangler deploy / pages deploy, supabase db push / functions deploy, terraform apply, vercel --prod) and, when `repo.prodBranch` is set and differs from the landing branch (`repo.devBranch`, default `main`), a `git push` to that branch. `predeploy.deployGuard.patterns` only ADDS patterns; an explicitly empty list is a validation error (omit the key instead).

### `predeploy.runs` / `predeploy.minFreeGB` (D068)

`predeploy.runs: { keep, maxGB }` (defaults 5 / 10) caps the disposable gate run workspaces under `<git-common-dir>/maple/predeploy/runs`, pruned at run end, at every gate/live start and by `node <plugin>/scripts/predeploy/run.mjs prune [--all]`. `predeploy.minFreeGB` (default 20) is the free space the repo drive needs before a gate or live scan may start. Neither is part of the stamp's config hash. `run.mjs doctor` reports runs/ size and count, tf-plugin-cache size and free space.

### `predeploy.exposure` + the `stack-exposure` preset (D072, plugin v0.14.0)

The stack-exposure standard (docs/stack-exposure.md): an anonymous visitor learns nothing about the stack that it does not need,
and the login page is the smallest, most fingerprint-free surface of all. It is **on by default** for every project with a
`predeploy` block. Adopters must do one of these, or the gate fails with `exposure-standard:exposure-unconfigured`:

```json
"checks": [
  { "id": "exposure", "preset": "stack-exposure", "options": {
      "surfaces": [ { "name": "app", "dir": "app/dist", "build": "npm run build -w app", "exclude": ["_worker.js", "_routes.json", "_headers", "_redirects"],
                      "hashOnly": { "dir": "assets" }, "loginEntry": "login/index.html", "loginBudget": { "maxFiles": 20, "maxBytes": 200000 } } ],
      "devRoutes": ["/dev-softphone-harness"], "forbidden": ["dash.example.com"], "appMarkers": ["softphone"] } }
],
"exposure": { "live": { "loginGraph": { "target": "app", "path": "/login", "maxFiles": 20, "allowCode": false } } }
```

or, for a project with no web build (a pure API, a CLI), `"exposure": { "optOut": { "bundle": { "decision": "D###", "why": "..." } } }`
naming a decision in the project's own ledger. The build side runs each surface's `build` in the project root and scans what is
served (source maps, sensitive files, license banners, inlined env objects, the commit SHA, lockfile package versions, non-hash
asset names, dev routes, forbidden strings, the static login graph) plus nginx `server_tokens` and express `x-powered-by` in the
tracked tree. The live side runs inside `predeploy-gate --live`, anonymously, before ZAP: versioned `Server`, `X-Powered-By`,
version headers, server banners / stack traces / framework errors in bodies (target URL + a fixed not-found path + configured
`probes`), and the optional anonymous login crawl. `optOut.live` turns the live side off, again only with a ledger decision.
Rules are never switched off one by one: an unavoidable item (React's own runtime version check, a platform header) is one entry in
`predeploy-decisions.json` with scope `<surface dir>#<package or key>` (build) or the probed URL (live).

### `deps.*` — used by the `dep-version-guard` and `bash-guard` guards, `scripts/deps/check-dep-freshness.mjs` (D064)

| Key | Default | Notes |
|---|---|---|
| `deps.exceptions[]` | `[]` | decision-backed exceptions to "new dependencies are at the latest major": `{ name, range?, decision, why }`. `range` (optional) scopes it to one freshness bucket (same major; 0.x same minor). `decision` must be a `D###` present in `docs.decisions` — otherwise the exception is invalid (hooks deny, the gate fails). `why` >= 10 chars. |

The registry is `$npm_config_registry` (default `https://registry.npmjs.org`). `pnpm-workspace.yaml` `minimumReleaseAge` (minutes) makes "latest" mean the newest non-prerelease release older than that window — the same version pnpm installs.

### `loops.*` — used by the loop pack (`/dev-burner` + the four loop commands)

Canonical name is plural (`loops`, matching `docs/standard-architecture.md`)
— replaces the old singular `loop.*` block. The standing branch moved to
`repo.standingLoopBranch` (it's a repo-level fact, not loop-pack-specific);
per-loop-type budgets collapsed into one shared `budgetPerCycle` (the
canonical schema doesn't carry a separate budget per loop name):

| Key | Default | Notes |
|---|---|---|
| `loops.enabled` | `["sweep-errors", "burn-backlog", "sweep-quality", "detect-drift"]` | which loops `/dev-burner` rotates through. An explicit `[]` means "run nothing" (`pick-loop.mjs` throws rather than silently falling back to the full set) |
| `loops.budgetPerCycle.turns` | `40` | shared turn (iteration) ceiling per loop cycle, whichever loop is running — enforced by each command's own `budget.mjs check --used $ITER` calls in its procedure |
| `loops.budgetPerCycle.minutes` | `20` | shared wall-clock ceiling per loop cycle |
| `loops.budgetPerCycle.toolCalls` | `400` | plugin extension (re-review B2) — `plugin/hooks/guards/loop-budget-guard.mjs`'s own runaway backstop. Counts the TOOL CALLS the dispatcher sees (Bash/PowerShell/Read/Grep/Glob/Write/Edit/MultiEdit/MCP), a DIFFERENT UNIT from `.turns` (loop iterations) — deliberately generous; this is a mechanical last-resort, not the primary per-cycle budget |
| `loops.weights.<loopName>` | `1` for every loop | plugin extension (docs/tasks.md #T8) — `pick-loop.mjs`'s round-robin weight per loop; only keys already in `loops.enabled`'s name set are meaningful, and `validate-config.mjs` rejects any other name |
| `loops.cooldownCycles` | `3` | plugin extension — how many ledger cycles a loop that just reported `"quiet"` is skipped for by `pick-loop.mjs`; `0` disables cooldown |
| `loops.sessionCap.cycles` / `.hours` | unset (no cap) | plugin extension — `/dev-burner` step 2's optional global budget; unset means the standing `/loop` session's own stop mechanism is the only ceiling |

See `repo.standingLoopBranch` above for the branch these loops work on.

### `jev.*` — Jev decision-model integration

| Key | Default | Notes |
|---|---|---|
| `jev.enabled` | `true` | Every `jev.*` call fails open (routing falls back to the default ladder rung, validation never blocks, search/skill-select return "no verdict") when no key is configured — leaving this `true` with no TypeSafe key costs nothing but one credential-store miss per call |
| `jev.credentialTarget` | `null` | Credential-store target name to try first; `plugin/scripts/jev/client.mjs` then tries `Maple-TypeSafe-APIKey`, then `MapleLens-TypeSafe-APIKey` |
| `jev.confidenceFloor` | `0.5` | Below this confidence, a Jev CHOICE answer is treated as "don't know" and the caller uses its own fallback (jev-model-routing uses its own separate, higher floor — see below — for escalating past the default executor) |
| `jev.timeoutMs` | `3000` | Fail-open budget per Jev call — deliberately short; these calls run inline in a hook or skill |
| `jev.credentialCacheTtlSeconds` | `300` | How long `client.mjs`'s DPAPI-encrypted per-user credential cache stays fresh before the next call re-reads Windows Credential Manager directly. `0` disables the cache. |

See "Jev" below for what each feature does with these.

## The loop pack

Four budget-bounded autonomous loops (`/sweep-errors`, `/burn-backlog`,
`/sweep-quality`, `/detect-drift`), orchestrated by `/dev-burner`, working
in one standing worktree on `repo.standingLoopBranch` (default
`"dev-burner"`) that is never merged or pushed by the pack itself — a human
reviews and lands it each morning. Full behavioral spec: `docs/loop-pack.md`
(the per-loop anatomy tables, the orchestrator's 7 steps, morning review);
this section is the implementation map.

**Start the standing session:** from inside the target project (with this
plugin installed and `maple.config.json` adopted), run `/loop /dev-burner`
— no interval argument, `/loop` self-paces. `/dev-burner` handles creating
the standing worktree on its own first cycle; you don't need to `/wt-start`
it yourself. `/dev-burner --report` at any time (including from a normal,
non-standing session) prints the morning-review ledger summary without
touching anything.

**The mechanical budget guard (`plugin/hooks/guards/loop-budget-guard.mjs`) is a
ONE-SHOT stop, not a standing block.** The first PreToolUse call that finds
a cycle over budget (wall-clock deadline, or its own `toolCalls` runaway
backstop — see `loops.budgetPerCycle.toolCalls` above) writes `blocked:
true` into `.loop-state/current-cycle.json` and exits 2 with the stop
message; every call after that for the same cycle exits 0 (allow), so the
agent can actually use Bash/Write/Edit to revert, log the outcome, and run
the loop's Report step (`budget.mjs end`, which clears the cycle and
un-blocks the next one). Re-blocking those exact remediation tools was an
unrecoverable deadlock in an earlier version — fixed, re-review B1.

### `plugin/scripts/loops/` — deterministic bookkeeping, no model judgment

Small, dependency-free, `node --check`-able modules, each importable AND a
thin CLI (same convention as `validate-config.mjs`), unit-tested with the
repo's standalone `*.test.mjs` style (`plugin/scripts/loops/run-tests.mjs`
runs them all, mirroring `supabase/tests/run-db-tests.mjs`):

| Script | What it does |
|---|---|
| `state.mjs` | Read/write `.loop-state/<loop>.json` — atomic write (tmp file + rename), tolerant read (missing file starts fresh silently; corrupt file starts fresh with a warning, never throws). |
| `ledger.mjs` | Append one JSON line per cycle to `.loop-state/dev-burner-ledger.jsonl` (`{ts, loop, outcome, commit, budgetUsed}`) + a `summarize` mode for morning review (per-loop counts/outcomes, commit list). Tolerant read skips corrupt/partial lines with a warning rather than failing the whole read. |
| `pick-loop.mjs` | Deterministic loop selection: weighted round-robin over `loops.enabled` (weights from `loops.weights`, ties broken by `loops.enabled` array order), a `loops.cooldownCycles` cooldown for a loop that just reported `"quiet"` (falls back to the full set if every loop is cooling down, so a cycle always picks something), and a priority override for `sweep-errors` that beats cooldown too. |
| `budget.mjs` | One boundary check (`usedCount >= countLimit` and/or elapsed-minutes past `minutesLimit` — AT the cap counts as exceeded; a `countLimit`/`minutesLimit` of 0 or negative means "no cap on that dimension", not "cap at zero") reused for both each loop's per-cycle budget (`loops.budgetPerCycle`) and `/dev-burner`'s optional session-level cap (`loops.sessionCap`). `start`/`end` also write/clear `.loop-state/current-cycle.json`, the mechanical guard's only input. |
| `resolve-root.mjs` | The ONE canonical "what worktree does this loop-state file belong to" resolver — git worktree toplevel from the caller's own current location (preferred), falling back to `CLAUDE_PROJECT_DIR`, then `process.cwd()`. Shared by `state.mjs`, `budget.mjs`, and `plugin/hooks/loop-budget-guard.mjs` so a writer and a reader can never silently disagree (re-review M4). |

Every loop-pack path is relative to a `root` (CLAUDE_PROJECT_DIR or cwd —
same convention as every other bundled script), which in practice is the
standing `dev-burner` worktree once `/dev-burner` has entered it.

### `.loop-state/` layout (gitignored, lives inside the standing worktree)

```
.loop-state/
  sweep-errors.json         # fingerprint -> outcome/ts (state.mjs)
  burn-backlog.json         # #T id -> outcome/ts/commit (state.mjs)
  sweep-quality.json        # walk cursor + this-run discards (state.mjs)
  detect-drift.json         # rotation cursor + dedup gap keys (state.mjs)
  dev-burner.json           # session marker ({sessionStartedAt}) for the session cap (state.mjs)
  dev-burner-ledger.jsonl   # one line per cycle, every loop (ledger.mjs)
```

Never committed as data — the ONLY commit that ever touches `.loop-state/`
existing is `/dev-burner` step 1's one-time `.gitignore` append (adding the
`.loop-state/` line if it's missing), never the state/ledger files
themselves. Because the standing worktree gets recreated from a fresh
`development` tip after each morning land (docs/loop-pack.md step 6), this
directory naturally resets with it — each night's ledger scopes to that
night's run.

### The five command files

`sweep-errors.md` / `burn-backlog.md` / `sweep-quality.md` /
`detect-drift.md` implement docs/loop-pack.md's per-loop anatomy exactly
(trigger, scope, action, budget via `budget.mjs`, a full `ci.tiers.gate`
verification gate before any commit — plus a red-before-fix/green-after
regression test for sweep-errors and sweep-quality's new-test candidates —
state via `state.mjs`, next-action logic, gate-red failure handling via
`git reset --hard` to the pre-attempt SHA). `dev-burner.md` implements the
7-step orchestrator plus `--report`. Cross-cutting rules (no `docs/` page
writes except detect-drift's scoped `gaps.md` append, burn-backlog never
checks off `tasks.md`, process corrections go to the cycle report only,
everything terminates at `repo.standingLoopBranch` and nothing merges or
pushes) are restated in each command file, not just here — see each file's
own "Cross-cutting loop-pack rules" section.

`plugin/scripts/agent-wt/maple-devburner.sh` (new, alongside
`maple-start.sh`/`maple-land.sh`/`maple-preview.sh`/`maple-reap.sh`) creates
or re-attaches the standing worktree, rebasing onto the fresh dev-branch tip
only when clean at cycle start, under the SAME global lock `maple-land.sh`
holds — so `/dev-burner` can never race a concurrent `/wt-land`.

### Dual-checkout layout — used by `/adopt-standard`

No separate `layout.*` block anymore — the old `layout.mode` /
`layout.devCheckoutPath` / `layout.devCheckoutBranch` keys are retired in
favor of the canonical `repo.*` fields already documented above
(`repo.prodCheckout`, `repo.devCheckout`, `repo.prodBranch`,
`repo.devBranch` — D008). Dual-checkout mode is simply "`repo.devCheckout`
is set"; there's no separate mode flag to keep in sync with it.

### Schema reconciliation (docs/tasks.md #T11)

The skeleton shipped with two config key sets that had drifted apart: the
`wt-*` scripts + some commands invented their own flat `worktree.*` /
`layout.*` blocks, and the (since removed) docs hooks shipped reading yet another, older `docs.*` key set
— neither matched `docs/standard-architecture.md`'s schema, which is
canonical. This pass migrated everything onto that one canonical schema
(`plugin/schema/maple.config.schema.json`, validated by
`plugin/scripts/validate-config.mjs`) — one key set, no aliases:

| Old key | New key |
|---|---|
| `worktree.remote` | `repo.remote` |
| `worktree.targetBranch` | `repo.devBranch` (if set) else `repo.prodBranch`, else detected |
| `worktree.branchPrefix` | `worktrees.namePattern` (`<slug>` placeholder) |
| `worktree.root` | `worktrees.root` |
| `worktree.nodeModulesDirs` | `worktrees.nodeModulesDirs` |
| `worktree.envFiles` | `worktrees.envFiles` |
| `worktree.freshDepsCommand` | `worktrees.freshDepsCommand` |
| `worktree.preview.*` | `worktrees.preview.*` |
| `worktree.lock.*` | `worktrees.lock.*` |
| `worktree.reap.staleHours` | `worktrees.reap.staleHours` |
| `worktree.gate.defaultTier` | `ci.prePushTier` |
| `worktree.gate.tiers.<name>` | `ci.tiers.<name>` |
| `layout.mode` / `.devCheckoutPath` / `.devCheckoutBranch` | `repo.devCheckout` / `repo.devBranch` (mode = "devCheckout is set") |
| `docs.decisionsFile` | `docs.decisions` |
| `docs.tasksFile` | `docs.tasks` |
| `docs.gapsFile` | `docs.gaps` |
| `docs.indexFile` (the JSON index, confusingly named) | `docs.docsIndexJson` |
| `docs.changelogFile` | `docs.changelog` |
| `docs.searchScript` (optional project-local BM25 script) | retired — doc search is the plugin's own bundled `doc-search/search.mjs` |
| `docs.idAllocatorScript` (guidance text only) | retired — always the plugin's bundled `next-task-id.mjs` |
| `errorTracker.kind` | `errorTracker.provider` |
| `errorTracker.org` + `errorTracker.project` | `errorTracker.sentryProject` |
| `errorTracker.*` T1-T5 ladder (was nested under `ci.tiers.*`, colliding with the wt-land gate tiers of the same name) | `errorTracker.verification.*` |
| `loop.worktreeBranch` | `repo.standingLoopBranch` |
| `loop.devBurner.loops` | `loops.enabled` |
| `loop.devBurner.selection` | retired (no canonical equivalent; round-robin is now the only behavior) |
| `loop.budgets.<name>.maxIterations`/`.maxMinutes` (per-loop-type) | `loops.budgetPerCycle.turns`/`.minutes` (one shared budget) |

Every plugin extension that survives reconciliation (things the canonical
schema's illustrative example doesn't spell out, like preview-server
tuning or lock timing) is nested under the matching **canonical** top-level
block (`repo.*` / `worktrees.*` / `docs.*` / `errorTracker.*`) — never a
new sibling block — and is marked "plugin extension" in the tables above.

## Jev — decision-model routing, skill-select, search, sub-agent validation

Jev (TypeSafe System One) is a typed decision model — choice/score/
probability answers in well under a second, never prose — used four ways in
this plugin instead of spending a full Claude turn on a decision a
calibrated probability answers better:

| Feature | Skill / hook | What it decides |
|---|---|---|
| **Model routing** | `plugin/skills/jev-model-routing` | Before delegating to a sub-agent: which rung on the ladder `gpt-5.6-luna -> gpt-5.6-terra -> gpt-5.6-sol -> sonnet -> opus` to start on. **The default is the cheapest rung (Pi on gpt-5.6-luna)** — Jev only escalates when confident (>= 0.8) the task needs more; see `ladder.mjs`/D057. |
| **Skill selection** | `plugin/skills/jev-skill-select` | Ranks the installed skill catalog against a request; may say none apply |
| **Search decisions** | `plugin/skills/jev-search` | After a search round: which results to read, whether that's enough, which caller-written query to run next |
| **Sub-agent validation** | `plugin/hooks/jev-validate-subagent.mjs` (`SubagentStop`) | Judges a sub-agent's task + final report before the main session trusts it; blocks once (never twice — guarded by `stop_hook_active`) with Jev's concerns if the report looks incomplete. The same judge (`validate.mjs`) applies to a `pi-run.mjs` result too. |

Shared code: `plugin/scripts/jev/client.mjs` (the API client — direct
TypeSafe endpoint, not a gateway; ported from `C:\Projects\MapleLens\tools\jev\client.mjs`,
same endpoint/model pin/question shapes, plus a DPAPI-encrypted per-user
credential cache — see its module docstring), `config.mjs` (`jev.*`
resolver), `redact.mjs` (masks emails/tokens/hex/phone-shaped numbers
before anything is sent), `log.mjs` (`.maple/jev-decisions.jsonl`,
gitignored — review with `node plugin/scripts/jev/report.mjs [root]`),
`ladder.mjs` (the five-rung executor ladder — `PI_MODEL_LADDER`,
`startModelFor()`, `nextRung()` — both what `route.mjs` routes TO and what
a caller escalates ALONG after a failed validation), `validate.mjs` (the
shared "did this agent finish the task" judge used by both the
SubagentStop hook and `pi-run.mjs`'s caller), `pi-run.mjs` (headless Pi in
an isolated `.worktrees/pi-*` worktree, on a caller-chosen model — trimmed
from MapleLens's `tools/jev/worker-pi.mjs` + `worktree.mjs`; no
checkpoint/revert/patch-cap machinery or auto-escalation loop, this is
single-shot; also runnable as a CLI, `node plugin/scripts/jev/pi-run.mjs
--task ... --prompt ... [--model gpt-5.6-terra]`).

**What leaves the machine**, per feature: routing sends a clipped+redacted
task description (~900 chars) and short context (~300 chars); skill-select
sends a clipped request (~600 chars) and each skill's `name`+description
(~200 chars each); search sends the question (~400 chars), queries already
tried, and up to 12 results' title+snippet (~300 chars each); sub-agent
validation sends the task prompt and final report (~1500 chars each). All
five go through `redact.mjs` first, and anything that looks like it holds a
secret or password/private-key block is not sent at all — the feature falls
back instead.

**Credential**: OS credential store only (`plugin/skills/credential-manager`)
— target name resolution order is `jev.credentialTarget` →
`Maple-TypeSafe-APIKey` → `MapleLens-TypeSafe-APIKey`. No key configured is
the normal, fully-supported "Jev off" state — every feature above fails
open to its non-Jev default, never an error. Since each hook/skill
invocation is a fresh Node process, `client.mjs` also keeps a short-TTL
(`jev.credentialCacheTtlSeconds`, default 300s) per-user cache file under
`%LOCALAPPDATA%\maple-standard\jev\`, DPAPI-encrypted via PowerShell's
built-in `ConvertFrom-SecureString` (never the plaintext key on disk) —
cuts the credential-read leg of a call roughly in half by skipping the
CredentialManager module import on a cache hit; see the module docstring
for the full threat-model reasoning and why the PowerShell process-startup
cost itself isn't avoidable without a new dependency.

**Gaps** (see also "Gaps" below): `pi-run.mjs` is single-shot only (no
supervised multi-turn mission loop, unlike MapleLens's `supervise.mjs`);
`jev-skill-select`/`jev-search` are one-request simplifications of
hermes-jev-skills' batched/two-round-trip designs (see each skill's
`NOTICE`) — fine for a single session's catalog/result-set size, not
load-tested at fleet scale.

## Layer map

Four layers, each owned differently — knowing which layer a file lives in
tells you who's allowed to edit it and when it updates:

1. **Plugin** (`plugin/` in this repo) — the stack-agnostic machinery:
   commands, hooks, the `agent-wt` scripts (including the loop pack's
   `maple-devburner.sh`), the loop pack's own bookkeeping helpers under
   `plugin/scripts/loops/`. Versioned with the plugin
   (`plugin/.claude-plugin/plugin.json`); updates ship to every adopting
   project via the marketplace, not by hand-editing a copy.
2. **Template** (everything else in this repo: `src/`, `supabase/`,
   `eslint.config.mjs`, `scripts/check-docs-drift.mjs`, etc.) — the
   opinionated Next.js/Supabase starter. Only relevant if you clone
   `maple-standard` itself as a new project's starting point; the plugin
   works independently of it.
3. **Bootstrap-generated** (per adopting project, written once by
   `/adopt-standard` and then owned by that project): `maple.config.json`,
   `docs/index.md` / `gaps.md` / `tasks.md` / `log.md` / `decisions.md`,
   `CLAUDE.md`. The plugin never overwrites these after creation — they're
   the project's own from that point on.
4. **User-global** (`~/.claude/CLAUDE.md` and similar) — the owner's
   cross-project preferences (communication style, session conventions).
   Out of scope for this plugin entirely; it only ever touches
   project-local files.

## Gaps (honest inventory — see also each command file's own "Gap" section)

- **`ci.tiers.*` has no default command** — every adopting project must
  define its own gate commands; there's no bundled generic gate script (the
  original VeHagita `ci-local.sh` was too project-specific to generalize
  into one).
- **No Supabase-CLI-style per-tool worktree workaround.** The original
  `vh-land.sh` set `SUPABASE_WORKDIR` so the Supabase CLI resolved its local
  stack from inside a worktree. Generic equivalent: bake any such
  workaround directly into your `ci.tiers.<name>` command string.
- **`/heal` can't name the exact MCP tool to call.** MCP server ids are
  per-installation; the command describes the shape of each tracker call
  (query, cluster, resolve) but the operator's session needs a matching
  error-tracker MCP server actually configured. `/heal` itself is still
  unimplemented (#T9) — the `errorTracker.*` schema exists ahead of the
  command.
- **The "prod/dev dual-checkout" repo layout is a new convention**, not a
  pre-existing Studio Maple standard — `/adopt-standard` defines a working
  detection heuristic (see its own "Gap" section) pending a real spec; there
  is no marker file or git config declaring the prod/dev relationship, only
  directory-name + branch-name heuristics.
- **The loop pack has never run against a real overnight session.** It's
  implemented per `docs/loop-pack.md` and unit-tested at the
  `plugin/scripts/loops/` bookkeeping layer, but the five command files
  (procedural instructions for an agentic session, same as every other
  command in this plugin) haven't yet been exercised end-to-end by a live
  standing `/loop /dev-burner` session against a real tracker/backlog/repo
  history. Expect rough edges in the first real overnight run — feed them
  back as process corrections per docs/loop-pack.md, not silent self-fixes.
- **"Concrete and actionable" (`/burn-backlog`) and "genuine drift vs.
  intentional" (`/detect-drift`) are judgment calls**, same category as
  `/heal`'s stale-check heuristics — there's no tag/label convention in
  `docs/tasks.md` or a drift-confidence score today that would make either
  call mechanical instead of judged per cycle.
- **`/sweep-quality`'s diff-size cap is judgment, not a configured number**
  — docs/loop-pack.md doesn't specify one; if that proves too loose, a real
  cap belongs in a new/extended config key (`sizeCaps.*` or `loops.*`),
  added through `validate-config.mjs` the same way as any other schema
  change, not invented ad hoc in the command file.
- **`/dev-burner`'s "new high-severity tracker issues" priority check
  (step 3) inherits `/heal`'s MCP-tool-naming gap** — it can describe the
  shape of the query but not the literal MCP tool id, so it silently no-ops
  (priority flag stays false) when no matching error-tracker MCP server is
  configured in the standing session, same as `/heal` itself.
- **The validator (`plugin/scripts/validate-config.mjs`) is hand-rolled,
  not a general JSON-Schema interpreter** — it mirrors
  `plugin/schema/maple.config.schema.json` by inspection rather than
  executing it, per docs/tasks.md #T11's "keep it small" brief. The two
  need to be kept in sync by hand; a drift between them would show as the
  validator accepting/rejecting something the schema file disagrees with.
- **`/adopt-standard` step 6 only CHECKS hook wiring** (`check-hook-wiring.mjs`):
  `plugin/hooks/hooks.json` is the plugin's own, versioned with the plugin, and
  no hook copies are planted in a project. A project registration or stale copy
  of a plugin/removed hook is reported for deletion, never merged.
- **`jev-validate-subagent.mjs`'s block mechanism uses the confirmed
  `SubagentStop` exit-code-2 contract** (stderr fed back as the reason the
  sub-agent must continue — the same convention the PreToolUse dispatcher uses to deny), not a documented JSON `decision`/`hookSpecificOutput`
  shape for `Stop`/`SubagentStop` — Claude Code's docs describe the exit-2
  behavior but the excerpted schema didn't include a worked JSON-output
  example for this event pair to cross-check against. If a future Claude
  Code version adds one, prefer it; exit 2 + stderr is the confirmed
  fallback either way.
- **`pi-run.mjs` is single-shot** — one prompt, one worktree, one diff, no
  supervised multi-turn mission loop, checkpoint/revert, or patch-size cap
  (unlike MapleLens's `tools/jev/supervise.mjs` + the fuller
  `tools/jev/worktree.mjs`). A `pi` executor pick that needs back-and-forth
  isn't supported yet — `jev-model-routing`'s prompt asks Jev to only
  choose `pi` for well-scoped, self-contained work for this reason.
- **`jev-skill-select` and `jev-search` are one-request simplifications**
  of hermes-jev-skills' batched/two-round-trip designs (see each skill's
  `NOTICE`) — correct for a single Claude Code session's catalog/result-set
  size, not measured at the fleet scale those designs were built for.
- **`ladder.mjs`'s `nextRung()` is a pure function, not an automatic retry
  loop** — nothing in this plugin re-dispatches a failed sub-agent at the
  next rung on its own; a caller (a command, a future loop-pack entry)
  reads `nextRung(previousModel)` and drives the retry itself. See
  jev-model-routing's SKILL.md "Escalating after a failed validation"
  section.
- **The credential cache's DPAPI decrypt path was live-tested, not just
  unit-tested** — `parseCacheFile`/`isCacheFresh`/`cacheFilePathFor` are
  pure and covered by `client.test.mjs`, but the actual
  `ConvertTo-SecureString`/`ConvertFrom-SecureString` round trip only runs
  against the real credential store, so it's exercised by the live smoke
  test each release rather than by CI (no Windows Credential Manager in
  the plugin's own test environment).
