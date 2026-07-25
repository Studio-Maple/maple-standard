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
`sync-docs`, `heal`) carry real structure and logic. The loop-pack commands
(`sweep-errors`, `burn-backlog`, `sweep-quality`, `detect-drift`,
`dev-burner`) are intentionally stubs pending a `docs/loop-pack.md` spec.
`adopt-standard` is a real bootstrap. See "Gaps" below for what's not done
yet.

## What you get

| Component | What it does |
|---|---|
| `/wt-start`, `/wt-land`, `/wt-preview`, `/wt-reap` | Isolated parallel-session git worktrees + a single merge semaphore (`/wt-land`) so concurrent Claude sessions never collide on the shared tree. |
| `/sync-docs` | The docs-drift **executor** — semantic reconciliation of `docs/` against code, backed by a project's own structural drift script. |
| `/heal` | Error-tracker-driven self-healing: fetch, cluster, triage, fix, and verify unresolved issues through a 5-tier ladder before marking them resolved. |
| `/adopt-standard` | Bootstrap: stamps `maple.config.json`, scaffolds canonical `docs/` files + `CLAUDE.md` if missing, generates the docs index. |
| `/sweep-errors`, `/burn-backlog`, `/sweep-quality`, `/detect-drift`, `/dev-burner` | The **loop pack** — budget-bounded autonomous loops orchestrated by `/dev-burner` under `/loop`, working in an isolated `dev-burner` worktree that never self-merges. Stubs until `docs/loop-pack.md` is approved. |
| `plugin/hooks/hooks.json` | 8 always-on safety/hygiene hooks (credential-read blocking, secret scrubbing, a Bash cwd/push guard, dirty-tree + decision + docs-sync reminders, parallel-session warning). |

## Install

1. **Add the marketplace** (once per machine, from this repo):
   ```
   /plugin marketplace add C:\Projects\Studio-Maple\maple-standard
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

Lives at the adopting project's root. **Every key is optional** — omit
anything and its default applies. Only keys actually read by a shipped
command or hook are listed (no speculative keys).

### `worktree.*` — used by `/wt-start`, `/wt-land`, `/wt-preview`, `/wt-reap`

| Key | Default | Notes |
|---|---|---|
| `worktree.remote` | `"origin"` | |
| `worktree.targetBranch` | origin's default branch (`git symbolic-ref refs/remotes/origin/HEAD`), else `"main"` | the integration branch |
| `worktree.branchPrefix` | `"agent/"` | ephemeral worktree branches are `<prefix><slug>` |
| `worktree.root` | `"../<repo-name>-wt"` | sibling dir holding all worktrees; relative paths resolve against the repo root |
| `worktree.nodeModulesDirs` | `["."]` | dirs (repo-root-relative) whose `node_modules` gets junction/symlinked into a new worktree |
| `worktree.envFiles` | `[]` | gitignored env files (repo-root-relative) hardlinked into a new worktree |
| `worktree.freshDepsCommand` | `"npm ci"` | run instead of linking, with `/wt-start --fresh-deps` |
| `worktree.preview.port` | `8080` | the one shared preview dev-server port |
| `worktree.preview.workdir` | `"."` | dir (relative to the worktree) the preview command runs in |
| `worktree.preview.command` | `"npm run dev -- --port {port} --host 127.0.0.1"` | `{port}` substituted |
| `worktree.preview.logFile` | `".preview-dev.log"` | relative to the preview worktree |
| `worktree.gate.defaultTier` | `"gate"` | which tier `/wt-land` runs with no `--tier` |
| `worktree.gate.tiers.<name>` | **none** | shell command string run as the gate for that tier — **required** for any tier you invoke; `/wt-land` refuses to land ungated rather than guess |
| `worktree.lock.ttlSeconds` | `1800` | stale-lock steal threshold |
| `worktree.lock.waitSeconds` | `3600` | total queue-wait before `/wt-land` gives up |
| `worktree.lock.pollSeconds` | `5` | lock poll interval |
| `worktree.reap.staleHours` | `24` | idle threshold for `/wt-reap --force` |

### `docs.*` — used by `/sync-docs`, `/adopt-standard`, and the docs-aware hooks

| Key | Default | Notes |
|---|---|---|
| `docs.root` | `"docs"` | the wiki folder (flat or nested) |
| `docs.indexFile` | `"docs/.docs-index.json"` | machine-readable doc -> `Code:` anchor map |
| `docs.decisionsFile` | `"docs/decisions.md"` | read by `ask-gate` and `decision-reminder` |
| `docs.tasksFile` | `"docs/tasks.md"` | read by `ask-gate` |
| `docs.gapsFile` | `"docs/gaps.md"` | read by `ask-gate` |
| `docs.changelogFile` | `"CHANGELOG.md"` | checked by `docs-sync-reminder` |
| `docs.ephemeralPaths` | `[]` | doc-relative paths not owned by code — skipped by `/sync-docs` ownership resolution |
| `docs.driftScript` | `"scripts/check-docs-drift.mjs"` | **not bundled** — must already exist in the project (see Gaps) |
| `docs.indexScript` | `"scripts/generate-docs-index.mjs"` | **not bundled** — same caveat |
| `docs.idAllocatorScript` | `"scripts/next-task-id.mjs"` | guidance text only (`decision-reminder`'s nudge message); not invoked by any hook |
| `docs.searchScript` | `"scripts/doc-search/search.mjs"` | **optional** — a project-local BM25 doc searcher `ask-gate` will use if present; absent is fine, it falls back to a line-grep signal |

### `errorTracker.*` and `ci.tiers.*` — used by `/heal`

| Key | Default | Notes |
|---|---|---|
| `errorTracker.kind` | `"sentry"` | `"sentry"` \| `"maplelens"` |
| `errorTracker.org` | **none — required** | |
| `errorTracker.project` | **none — required** | |
| `errorTracker.endpoint` | **none** | Sentry: region URL. maplelens: API base URL. |
| `errorTracker.query` | `"is:unresolved"` | overridden by `/heal`'s `$ARGUMENTS` |
| `errorTracker.livePreviewUrl` | **none** | base URL for the T3/T4 live-verification tiers |
| `ci.tiers.t1` | `["npx eslint --cache .", "npx tsc --noEmit", "npm run build"]` | pre-commit commands, run in order |
| `ci.tiers.t2.pushCommand` | `"git push origin HEAD"` | |
| `ci.tiers.t2.ciWatchCommand` | `""` (tier skipped if empty) | e.g. `"gh run watch"` |
| `ci.tiers.t3.deployUrlTemplate` | `""` (tier skipped if empty) | `{livePreviewUrl}` / `{page}` / `{sha}` substituted |
| `ci.tiers.t3.waitSeconds` | `20` | poll interval waiting for the deploy to flip |
| `ci.tiers.t4.enabled` | `true` | browser console/network check |
| `ci.tiers.t5.waitMinutes` | `8` | wait before the post-deploy tracker recheck |

### `hooks.bashGuard.*` — used by `plugin/hooks/bash-guard.mjs`

| Key | Default | Notes |
|---|---|---|
| `hooks.bashGuard.cwdGuardEnabled` | `true` | blocks bare `npm`/`npx`/`yarn`/`pnpm` without an anchoring `cd` |
| `hooks.bashGuard.pushGuardEnabled` | `true` | blocks a foreground `git push` without `run_in_background`/a long timeout |
| `hooks.bashGuard.pushGuardMinTimeoutMs` | `600000` | minimum explicit timeout that satisfies the push guard |

### `loop.*` — used by the (stub) loop-pack commands

| Key | Default | Notes |
|---|---|---|
| `loop.worktreeBranch` | `"dev-burner"` | the standing branch `/dev-burner` works on; never auto-merged |
| `loop.devBurner.loops` | `["sweep-errors", "burn-backlog", "sweep-quality", "detect-drift"]` | rotation order |
| `loop.devBurner.selection` | `"round-robin"` | selection strategy |
| `loop.budgets.sweepErrors.maxIterations` / `.maxMinutes` | `10` / `30` | |
| `loop.budgets.burnBacklog.maxIterations` / `.maxMinutes` | `5` / `45` | |
| `loop.budgets.sweepQuality.maxIterations` / `.maxMinutes` | `10` / `30` | |
| `loop.budgets.detectDrift.maxIterations` / `.maxMinutes` | `5` / `15` | |

### `layout.*` — used by `/adopt-standard`

| Key | Default | Notes |
|---|---|---|
| `layout.mode` | `"single-checkout"` | `"single-checkout"` \| `"dual-checkout"` — see `/adopt-standard`'s "Gap" note; this convention is newly defined by this plugin, not an established Studio Maple doc yet |
| `layout.devCheckoutPath` | **none** | dual-checkout only — where the persistent dev checkout lives |
| `layout.devCheckoutBranch` | **none** | dual-checkout only — the branch it tracks |

## Layer map

Four layers, each owned differently — knowing which layer a file lives in
tells you who's allowed to edit it and when it updates:

1. **Plugin** (`plugin/` in this repo) — the stack-agnostic machinery:
   commands, hooks, the `agent-wt` scripts. Versioned with the plugin
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

- **Docs tooling isn't bundled.** `scripts/check-docs-drift.mjs` and
  `scripts/generate-docs-index.mjs` are referenced by `docs.driftScript` /
  `docs.indexScript` but not copied into `plugin/scripts/` — a non-template
  project adopting this plugin needs to supply its own (or a future plugin
  version needs to bundle generic copies). `/sync-docs` and
  `/adopt-standard` both degrade gracefully (skip the step, say so) when
  they're missing.
- **`worktree.gate.tiers.*` has no default command** — every adopting
  project must define its own gate commands; there's no bundled generic
  gate script (the original VeHagita `ci-local.sh` was too project-specific
  to generalize into one).
- **No Supabase-CLI-style per-tool worktree workaround.** The original
  `vh-land.sh` set `SUPABASE_WORKDIR` so the Supabase CLI resolved its local
  stack from inside a worktree. Generic equivalent: bake any such
  workaround directly into your `worktree.gate.tiers.<name>` command string.
- **`/heal` can't name the exact MCP tool to call.** MCP server ids are
  per-installation; the command describes the shape of each tracker call
  (query, cluster, resolve) but the operator's session needs a matching
  error-tracker MCP server actually configured.
- **The "prod/dev dual-checkout" layout (`layout.mode`) is a new
  convention**, not a pre-existing Studio Maple standard — `/adopt-standard`
  defines a working definition (see its own "Gap" section) pending a real
  spec.
- **Loop pack is entirely stubbed** pending `docs/loop-pack.md` (doesn't
  exist yet — that spec is the approval gate the whole pack is waiting on).
- **`ask-gate`'s BM25 signal has no bundled searcher** (`docs.searchScript`)
  — fails open to a simpler line-grep match, which is weaker but never
  breaks the gate.
