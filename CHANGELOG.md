# Changelog

All notable changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); newest first. The
`docs-sync-reminder` hook nags when code changes land without an entry here.

## [Unreleased]

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
