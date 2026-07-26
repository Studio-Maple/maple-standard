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
| `/sync-docs` | The docs-drift **executor** — semantic reconciliation of `docs/` against code, backed by the bundled structural drift script (`plugin/scripts/docs/check-docs-drift.mjs` — see "Bundled docs tooling" below), OKF v0.1 frontmatter-aware per D010. |
| `/heal` | Error-tracker-driven self-healing: fetch, cluster, triage, fix, and verify unresolved issues through a 5-tier ladder before marking them resolved. |
| `/adopt-standard` | Bootstrap: validates + stamps `maple.config.json`, scaffolds canonical `docs/` files + `CLAUDE.md` if missing, generates the docs index, merges in the plugin's hooks, verifies the docs gate + a CI tier before declaring done. |
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
| `worktrees.root` | `"../<repo-name>-wt"` | sibling dir holding all worktrees; relative paths resolve against the repo root |
| `worktrees.namePattern` | `"agent/<slug>"` | `<slug>` is substituted; replaces the old invented `branchPrefix` key — prefix/suffix around the placeholder are derived from this pattern |
| `worktrees.nodeModulesDirs` | `["."]` | plugin extension — dirs (repo-root-relative) whose `node_modules` gets junction/symlinked into a new worktree |
| `worktrees.envFiles` | `[]` | plugin extension — gitignored env files (repo-root-relative) hardlinked into a new worktree |
| `worktrees.freshDepsCommand` | `"npm ci"` | plugin extension — run instead of linking, with `/wt-start --fresh-deps` |
| `worktrees.preview.port` | `8080` | plugin extension — the one shared preview dev-server port |
| `worktrees.preview.workdir` | `"."` | dir (relative to the worktree) the preview command runs in |
| `worktrees.preview.command` | `"npm run dev -- --port {port} --host 127.0.0.1"` | `{port}` substituted |
| `worktrees.preview.logFile` | `".preview-dev.log"` | relative to the preview worktree |
| `worktrees.lock.ttlSeconds` | `1800` | plugin extension — stale-lock steal threshold |
| `worktrees.lock.waitSeconds` | `3600` | total queue-wait before `/wt-land` gives up |
| `worktrees.lock.pollSeconds` | `5` | lock poll interval |
| `worktrees.reap.staleHours` | `24` | idle threshold for `/wt-reap --force` |

### `ci.*` — used by `/wt-land` (the gate), `/adopt-standard`, `/sweep-quality`

| Key | Default | Notes |
|---|---|---|
| `ci.tiers.<name>` | **none** | shell command string run as the gate for that tier (conventionally `fast`/`gate`/`core`/`full`) — **required** for any tier you invoke; `/wt-land` refuses to land ungated rather than guess. Replaces the old invented `worktree.gate.tiers.<name>` key. |
| `ci.prePushTier` | `"gate"` | which tier `/wt-land` runs with no `--tier`. Replaces the old `worktree.gate.defaultTier`. |

### `docs.*` — used by `/sync-docs`, `/adopt-standard`, the bundled docs tooling, and the docs-aware hooks

| Key | Default | Notes |
|---|---|---|
| `docs.root` | `"docs"` | the wiki folder (flat or nested) |
| `docs.index` | `"docs/index.md"` | the catalog page |
| `docs.decisions` | `"docs/decisions.md"` | read by `ask-gate` and `decision-reminder` |
| `docs.tasks` | `"docs/tasks.md"` | read by `ask-gate` |
| `docs.gaps` | `"docs/gaps.md"` | read by `ask-gate` |
| `docs.log` | `"docs/log.md"` | session history |
| `docs.docsIndexJson` | `"docs/.docs-index.json"` | machine-readable doc -> code anchor map, checked by `docs-sync-reminder` |
| `docs.changelog` | `"CHANGELOG.md"` | plugin extension (nested under the canonical `docs` block) — checked by `docs-sync-reminder` |
| `docs.ephemeralPaths` | `[]` | plugin extension — doc-relative paths not owned by code — skipped by `/sync-docs` ownership resolution |

Every one of these is the **same** key `ask-gate.mjs`, `docs-sync-reminder.js`,
`decision-reminder.js`, and every script under `plugin/scripts/docs/` reads
— one key set, no aliases (this used to be two drifted-apart sets; see
"Schema reconciliation" below). There is no more `docs.searchScript` key:
`ask-gate`'s BM25 relevance signal now always uses the plugin's own bundled
`plugin/scripts/docs/doc-search/search.mjs` (#T13) directly, so every
adopting project gets it for free instead of needing to supply its own.
There is no more `docs.idAllocatorScript` key either — `decision-reminder`'s
guidance text always points at the plugin's own bundled
`plugin/scripts/docs/next-task-id.mjs`.

### Bundled docs tooling (`plugin/scripts/docs/`) — #T13

Canonical, generalized implementations of the four scripts a project's docs
gate needs, so a non-template adopter (VeHagita, EasyCaller) gets them for
free instead of owning its own copies:

| Script | What it does |
|---|---|
| `check-docs-drift.mjs` | The structural docs-drift gate — see its own header comment for the full ERROR/WARN inventory. `--fix` regenerates the index + catalog. |
| `generate-docs-index.mjs` | Walks `docs.root`, emits `docs.docsIndexJson`, and maintains the generated Catalog block in `docs.index` (see "OKF v0.1 frontmatter" below). |
| `next-task-id.mjs` | Collision-free `#T`/`D`/`S` id allocator (atomic lockfile mutex). Depended on by `/sync-docs`, `decision-reminder`, and this template's own `pnpm next-id`. |
| `doc-search/search.mjs` | BM25 doc search. Imported directly by `ask-gate.mjs` (both ESM) for its relevance signal — always on, no config key. |

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

### `hooks.bashGuard.*` — used by `plugin/hooks/bash-guard.mjs`

| Key | Default | Notes |
|---|---|---|
| `hooks.bashGuard.cwdGuardEnabled` | `true` | blocks bare `npm`/`npx`/`yarn`/`pnpm` without an anchoring `cd` |
| `hooks.bashGuard.pushGuardEnabled` | `true` | blocks a foreground `git push` without `run_in_background`/a long timeout |
| `hooks.bashGuard.pushGuardMinTimeoutMs` | `600000` | minimum explicit timeout that satisfies the push guard |

### `loops.*` — used by the (stub) loop-pack commands

Canonical name is plural (`loops`, matching `docs/standard-architecture.md`)
— replaces the old singular `loop.*` block. The standing branch moved to
`repo.standingLoopBranch` (it's a repo-level fact, not loop-pack-specific);
per-loop-type budgets collapsed into one shared `budgetPerCycle` (the
canonical schema doesn't carry a separate budget per loop name):

| Key | Default | Notes |
|---|---|---|
| `loops.enabled` | `["sweep-errors", "burn-backlog", "sweep-quality", "detect-drift"]` | which loops `/dev-burner` rotates through |
| `loops.budgetPerCycle.turns` | `40` | shared turn ceiling per loop cycle, whichever loop is running |
| `loops.budgetPerCycle.minutes` | `20` | shared wall-clock ceiling per loop cycle |

See `repo.standingLoopBranch` above for the branch these loops work on.

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
`layout.*` blocks, and the hooks (`ask-gate.mjs`, `docs-sync-reminder.js`,
`decision-reminder.js`) shipped reading yet another, older `docs.*` key set
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
| `docs.searchScript` (optional project-local BM25 script) | retired — `ask-gate.mjs` always uses the plugin's own bundled `doc-search/search.mjs` |
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
- **Loop pack is entirely stubbed** pending `docs/loop-pack.md` (doesn't
  exist yet — that spec is the approval gate the whole pack is waiting on).
- **The validator (`plugin/scripts/validate-config.mjs`) is hand-rolled,
  not a general JSON-Schema interpreter** — it mirrors
  `plugin/schema/maple.config.schema.json` by inspection rather than
  executing it, per docs/tasks.md #T11's "keep it small" brief. The two
  need to be kept in sync by hand; a drift between them would show as the
  validator accepting/rejecting something the schema file disagrees with.
- **`/adopt-standard`'s hook-merge step (6) doesn't (and can't) modify
  `plugin/hooks/hooks.json`** — that file is the plugin's own, versioned
  with the plugin, not per-project. Step 6 only reconciles **project-local**
  hooks already wired directly in the adopting project's own
  `.claude/settings.json` against the plugin's hook filenames, flagging
  collisions rather than resolving them automatically.
