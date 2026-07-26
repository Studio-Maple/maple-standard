---
description: Bootstrap an existing project onto the maple-standard (config + docs scaffold + hooks + verify)
---

# /adopt-standard — Bootstrap the maple-standard onto this project

Stamp `maple.config.json`, scaffold the canonical `docs/` files if they
don't exist, wire the plugin's generic hooks into this project's Claude Code
settings, and verify the result actually passes — so an **existing** project
(not a fresh clone of the maple-standard template) can use every other
command and hook in this plugin. Idempotent: never overwrite a file that
already has real content; only fill in what's missing. **Fail loud, never
guess** — anything this command can't safely infer gets asked, and a
verification failure is reported, not papered over.

This is the exact 7-step sequence from `docs/standard-architecture.md`
"Adoption sequence" (canonical — do not reorder or skip a step). Config keys
below are the canonical schema (`docs/standard-architecture.md`
`project`/`repo`/`worktrees`/`docs`/`ci`/`lint`/`sizeCaps`/`errorTracker`/
`loops`), validated against `plugin/schema/maple.config.schema.json` via
`plugin/scripts/validate-config.mjs` before anything is written.

## What this command writes

- `maple.config.json` at the project root (interactive — see step 2).
- `docs/index.md`, `docs/gaps.md`, `docs/tasks.md`, `docs/log.md`,
  `docs/decisions.md` — only the ones that don't already exist (step 3).
- `docs/.docs-index.json` — generated via the bundled index script (step 4).
- `CLAUDE.md` at the project root — created if missing, or a proposed diff
  if it already exists (step 5) — never a blind overwrite.
- `.claude/settings.json` — the plugin's generic-hook entries merged in
  (step 6) — never clobbers hooks already wired.

## Steps

### 1. Detect repo layout

Check for:
- An existing `maple.config.json` (if present, this is a **re-run** —
  everything below still applies, but step 2 shows a diff against what's
  there instead of starting from a blank slate; step 3-6 stay idempotent
  regardless).
- A sibling checkout implying the prod/dev dual-checkout convention (D008):
  if this repo is checked out at `<name>` (or `<name>-development` etc.),
  look for a sibling directory that looks like the other half of the pair
  (e.g. `../<name>` next to `<name>-development`, or vice versa) and check
  whether it's a git worktree/clone of the same repo (`git rev-parse
  --show-toplevel` + compare remote URLs, or `git worktree list` if it's a
  linked worktree rather than a separate clone).
  - Two real checkouts of the same repo found -> **dual-checkout**: note
    which one is which (the one on the "stable" branch — `main`/`master`/a
    release branch — is prod; the one on an ongoing integration branch —
    `development`/`develop`/`dev` — is dev).
  - Only one checkout, or the sibling doesn't resolve to the same repo ->
    **single-checkout**.
  - Ambiguous (e.g. two siblings that could both plausibly be it, or neither
    branch reads as clearly "stable" vs "ongoing") -> **do not guess** —
    surface what was found and ask in step 2.
- The project's current branch and, if resolvable, the origin default branch
  (`git symbolic-ref refs/remotes/origin/HEAD`).
- Whether `package.json` exists and what scripts it defines (informs the
  `ci.tiers.*` guess in step 2 — look for a `ci:fast`/`ci:gate`/`ci:core`/
  `ci:full` naming convention specifically, matching this template's own).

### 2. Write `maple.config.json`

**Ask the owner** (one `AskUserQuestion` call, multi-select + a free-write
option at the bottom, per Maayan's global convention) — only for what step 1
couldn't safely infer or detect unambiguously. Cover at least:

- **Project identity**: `project.name` (default: directory name or
  `package.json` `name`), `project.slug` (default: kebab-cased
  `project.name`, must match `^[a-z0-9-]+$`).
- **Repo layout** (skip if step 1 resolved it unambiguously): single- vs
  dual-checkout; if dual-checkout, confirm/correct which path is
  `repo.prodCheckout` and which is `repo.devCheckout`, and their branches
  (`repo.prodBranch`, `repo.devBranch`). If dual-checkout, also ask whether
  a standing `/dev-burner` loop branch is wanted now (`repo.standingLoopBranch`,
  default `"dev-burner"`) or deferred.
- **CI tier commands** (`ci.tiers.fast`/`.gate`/`.core`/`.full`, and
  `ci.prePushTier` — which tier `/wt-land` runs by default). Guess from
  `package.json` scripts if they follow the `ci:fast`/`ci:gate`/`ci:core`/
  `ci:full` convention; otherwise ask, and accept "none yet" as a valid
  answer for any tier — `/wt-land` simply refuses to land with that tier
  until one is configured, per its own design (it never invents a gate
  command).
- **Error tracker**: none / Sentry / maplelens (`errorTracker.provider`)
  and, if Sentry, `errorTracker.sentryProject`; leave `endpoint` /
  `readTokenRef` / `writeTokenRef` null until a MapleLens instance exists
  (see [[maplelens]]) — never ask for a literal token value, only a
  credential-manager reference name.
- **Docs layout**: does `docs/` already exist with its own structure (e.g.
  VeHagita's richer nested layout)? If so, don't assume the flat
  `docs/index.md` etc. defaults — ask for the actual paths, or confirm the
  defaults are right.

Always leave a free-write option at the bottom for anything not covered.

**Validate before writing.** Merge the owner's answers with this plugin's
defaults (see `plugin/README.md` for the full schema) — write only the keys
that differ from default, to keep the file short and let future default
changes flow through. Write the merged object to a **temp file** first, then
run:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/validate-config.mjs" <temp-file-path>
```

If it reports problems, **fix them and re-validate** — do not write a config
you know fails its own validator. Only once it passes, write the real
`maple.config.json` at the project root. If `maple.config.json` already
exists, show the diff between old and new and confirm before overwriting
(never silently clobber owner-tuned config).

### 3. Scaffold `docs/`

For each of `index.md`, `gaps.md`, `tasks.md`, `log.md`, `decisions.md`
under `docs.root` (from the config just written): if it doesn't exist,
create it from the standard minimal template (see below); if it exists,
leave it untouched. Report which ones were created vs. already present.

Minimal templates (adjust the preamble style to match any existing docs in
the project — don't introduce a second convention alongside one that
already exists). Default the preamble to OKF v0.1 frontmatter (D010 — see
this template's own `docs/*.md` as the reference shape) for a project with
no pre-existing docs convention; only fall back to the legacy prose
blockquote preamble when the project already has one and you're matching
it:
- `index.md` — one-line-per-page catalog, starting with the four/five files
  this command just created. Include `<!-- catalog:begin -->` /
  `<!-- catalog:end -->` markers around the generated section (step 4 fills
  it) if adopting OKF frontmatter; skip the markers if matching a legacy
  prose project.
- `gaps.md` — flat bullet list, "(none yet)" placeholder.
- `tasks.md` — `## Inbox` / `## In progress` / `## Blocked` headings, empty.
- `log.md` — append-only session history, empty with a one-line header
  comment explaining the format (`## SXXX | YYYY-MM-DD | title`).
- `decisions.md` — one `D001` entry recording "adopted maple-standard via
  /adopt-standard on <date>" so the ledger has a baseline, same spirit as
  this template's own `docs/decisions.md` D001.

### 4. Generate `docs/.docs-index.json`

Run the bundled index generator so the drift gate has something to check
against from commit one:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/generate-docs-index.mjs"
```

It reads `docs.root`/`docs.index`/`docs.docsIndexJson` from the
`maple.config.json` just written (`plugin/scripts/docs/lib/config.mjs` —
`CLAUDE_PROJECT_DIR` resolves the project root), so no project-side copy or
extra argument is needed. It's frontmatter-aware (OKF v0.1, D010) with a
legacy-prose fallback, so this works whether or not the scaffolded pages
have frontmatter yet.

### 5. Merge the `CLAUDE.md` skeleton

- **`CLAUDE.md` doesn't exist**: write a minimal skeleton — audience,
  one-paragraph project description placeholder, a pointer to
  `docs/index.md` for session start, and a note that this plugin's hooks +
  commands are active. Do **not** copy this template's full charter
  (long-run-over-patches rules, stack table, etc.) verbatim — that content
  is opinionated to *this* template's Next.js/Supabase stack; a `CLAUDE.md`
  for an arbitrary adopting project needs its own description of its own
  stack and workflow, written by the owner or a dedicated follow-up
  session, not invented here.
- **`CLAUDE.md` already exists**: propose the same minimal insertions
  (session-start pointer to `docs/index.md`, a note that the plugin's hooks
  are active) as a **diff** and ask for approval before writing anything —
  never a blind overwrite, never append silently. This is how a project
  with its own extras (VeHagita) keeps them (per [[rollout]]). If the
  owner declines, note it and move on — this step is optional, not a
  blocker for the rest of the sequence.

### 6. Wire hooks into `.claude/settings.json`

Read the project's `.claude/settings.json` (create it, `{}`-shaped, if
absent). The plugin's own hooks (`plugin/hooks/hooks.json`) are already
active for any project with the plugin installed — Claude Code loads a
plugin's `hooks.json` automatically, no per-project wiring needed for the
plugin's *own* hooks. This step is about the reverse direction: if the
project already has **project-local** hooks configured directly in
`.claude/settings.json` (e.g. this template's `.claude/hooks/*` — ESLint
fix, size warnings, build counter — which stay project-side per
`docs/standard-architecture.md`'s "Project-specific hooks stay out of the
plugin"), **do not touch or reorder them.**

Concretely:
- If `.claude/settings.json` has no `hooks` key at all, leave it alone —
  nothing to merge, the plugin's hooks already apply.
- If it has a `hooks` key with existing entries, verify none of them
  collide with the plugin's own hook filenames (`ask-gate.mjs`,
  `bash-guard.mjs`, `decision-reminder.js`, `deny-credential-paths.mjs`,
  `dirty-tree-guard.js`, `docs-sync-reminder.js`,
  `parallel-session-warn.js`, `scrub-secrets.mjs`) — if a project already
  has a same-named hook wired for the same event+matcher, flag the
  collision and ask which should win rather than silently layering both.
  Otherwise, no merge is needed (the plugin's hooks run independently via
  its own `hooks.json`) — report that project-local hooks were found and
  left untouched.

### 7. Verify

Run the docs-drift gate once and one CI tier once; report red/green.
Adoption isn't declared done on say-so — it's done when the gate the
project just inherited actually passes:

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/docs/check-docs-drift.mjs"
```

Then run whichever `ci.tiers.*` command was configured as `ci.prePushTier`
in step 2 (if any was configured — if the owner deferred all gate commands,
skip this half and say so explicitly rather than silently passing).

- **Both green**: report success — what was created, what was left alone,
  the resolved `maple.config.json`, and that the gate passes.
- **Docs gate red**: this command just scaffolded the docs files, so a red
  drift gate at this point is this command's own bug, not the project's —
  fix it (most likely: missing frontmatter, a stale `.docs-index.json` —
  re-run step 4) before reporting done.
  - regenerate via the option that resolves it (`--fix` if
  it's index/catalog staleness) and re-check.
- **CI tier red**: this is pre-existing project state, not something
  `/adopt-standard` caused — report the failure verbatim and stop; do not
  attempt to fix the project's own CI failures as part of adoption.

### 8. Report

Summarize: what was created, what was left alone, what's still missing, the
resolved `maple.config.json`, and the step-7 verification result — then
stop. Do not commit on the owner's behalf; that's their call.

## Gap: the "prod/dev dual-checkout" layout standard

The dual-checkout convention (D008) defines the two roles (prod / dev
checkout, each with its own branch) but not a mechanical way to *discover*
an existing pair from inside one of them beyond directory-name heuristics
and branch-name conventions (`main`/`master` reads as prod,
`development`/`develop`/`dev` reads as dev) — there's no marker file or git
config declaring the relationship. Treat step 1's heuristic as the working
definition until a real spec supersedes it, and always fail to "ask" (step
2) rather than guess when the heuristic is ambiguous. This command
**records** the convention in `maple.config.json`'s `repo.*` fields but does
**not** create a second checkout itself — creating a persistent git checkout
is a deliberate act the owner should do by hand (`git worktree add <path>
-b <branch>`, or a full second clone) before or after running this command.
