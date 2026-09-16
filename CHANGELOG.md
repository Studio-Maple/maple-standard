# Changelog

All notable changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); newest first. The
`docs-sync-reminder` hook nags when code changes land without an entry here.

## [Unreleased]

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
