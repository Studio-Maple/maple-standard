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
- `.claude/settings.json` — normally **left untouched**. The plugin's own
  hooks apply globally once the plugin is enabled — there's no per-project
  wiring step for the plugin's *own* hooks. Step 6 only checks whether the
  project already wires **project-local** hooks there directly and, if so,
  flags any filename collision with the plugin's hooks rather than merging
  anything in — per-project hook wiring is not normally needed at all.

## Resolving `$CLAUDE_PLUGIN_ROOT`

Every script invocation below (steps 2, 4, 7) uses `$CLAUDE_PLUGIN_ROOT` as
shorthand for "this plugin's installed root." It auto-populates **only**
inside a live plugin-loaded Claude Code session — the normal case when a
human or an interactive agent runs this command through the plugin. When
this sequence is instead carried out by an agent invoking the scripts
directly (headless, scripted, or otherwise outside a plugin-loaded
session), `$CLAUDE_PLUGIN_ROOT` is unset, and the literal commands below
will fail or silently no-op. Resolve it explicitly before running anything
under `scripts/`:

- If it's already set in the environment, use it as-is.
- Otherwise, resolve it from this command file's own location: a plugin's
  commands live at `<plugin-root>/commands/<name>.md`
  (`plugin/.claude-plugin/plugin.json` marks the root), so `<plugin-root>`
  is two directories up from wherever this file was loaded from — the
  agent carrying out this sequence already knows that path, since it just
  read this file to get these instructions. The plugin's own bash tooling
  uses the equivalent fallback already (`plugin/scripts/agent-wt/
  maple-lib.sh`'s `maple_check_config`: `${CLAUDE_PLUGIN_ROOT:-$(dirname
  "$0")/../..}`) — same idea, applied from the command file's path instead
  of a running script's `$0`.
- If neither resolves cleanly, **fail loud** rather than guessing a path
  and silently running the wrong script (or none at all) — ask for the
  plugin's installed path explicitly.

## Steps

### 1. Detect repo layout

Check for:
- An existing `maple.config.json` (if present, this is a **re-run** —
  everything below still applies, but step 2 shows a diff against what's
  there instead of starting from a blank slate; step 3-6 stay idempotent
  regardless).
- A sibling checkout implying the prod/dev dual-checkout convention (D008):
  if this repo is checked out at `<name>` (or `<name>-development`/
  `<name>-dev` etc.), look for a sibling directory that looks like the
  other half of the pair (e.g. `../<name>` next to `<name>-development`, or
  vice versa) and check whether it's a git worktree/clone of the same repo
  (`git rev-parse --show-toplevel` + compare remote URLs). Confirm the
  topology with `git rev-parse --git-common-dir` from each side: an
  IDENTICAL common-dir means the pair is **linked worktrees sharing one
  `.git`**, not two independent clones — don't assume clones; check. This
  is real, not hypothetical: EasyCaller's actual prod/dev pair (`C:/Projects
  /Caller` + `C:/Projects/Caller-development`) is linked worktrees, and it
  surprised the first adopter. (`git worktree list` from either side shows
  the whole pair when it's this topology.)
  - Two real checkouts of the same repo found -> **dual-checkout**. Resolve
    ROLE (which checkout is prod, which is dev) as a **persistent property
    of the checkout**, never from whichever branch it happens to have
    checked out right now — a checkout's current HEAD is routine mid-work
    state (an agent can leave either checkout on a feature/fix branch for
    days) and is not evidence about role on its own:
    1. **Directory-name convention first** — the durable signal, since it
       doesn't change every time someone runs `git checkout`: a
       `-development`/`-dev` suffix (or whatever analogous naming pair the
       two siblings actually share) names the dev checkout; the bare/
       unsuffixed name is prod.
    2. **Corroborate `repo.prodBranch`/`repo.devBranch` from which
       branches EXIST, repo-wide — not from either checkout's current
       HEAD.** List every branch across the pair (`git branch -a`; for
       linked worktrees this is one shared ref namespace anyway) and check
       which of `main`/`master`/`production`/a release-name branch EXISTS
       at all (-> `repo.prodBranch`) and which of `development`/`develop`/
       `dev` EXISTS (-> `repo.devBranch`). This is a fact about the repo's
       branch set, independent of which checkout currently has which
       branch checked out.
    3. **HEAD on neither candidate branch does not make this ambiguous** —
       it's the common case, not an edge case (EasyCaller's prod checkout
       sits on `feat/telephony-inbound`, its dev checkout on
       `fix/ci-covers-live-app` — neither is `production` or
       `development`). Keep the directory-derived role and the
       branch-list-derived `prodBranch`/`devBranch`; separately note each
       checkout's actual current branch as in-progress state (informational
       only — never written into `repo.*`, never used to flip role).
    4. **If directory names don't disambiguate** (neither sibling follows a
       recognizable dev-suffix convention): fall back to each checkout's
       reflog (`git reflog show HEAD`) and find the most recent `checkout:
       moving from <X> to <current>` entry — `<X>` is the branch this
       checkout was last on before its current mid-work state, a reasonable
       proxy for "the branch this checkout returns to."
  - Only one checkout, or the sibling doesn't resolve to the same repo ->
    **single-checkout**.
  - Still ambiguous after directory-name AND branch-list/reflog inference
    all fail to disambiguate -> **do not guess** — surface exactly what was
    found (both paths, the branches that exist, current HEAD of each,
    reflog signal if it came to that) and ask in step 2. Never resolve role
    from current HEAD alone.
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
  (`repo.prodBranch`, `repo.devBranch`). If dual-checkout, also confirm the
  branch name the standing loop pack should use (`repo.standingLoopBranch`,
  default `"dev-burner"`) — this is just a **name**, set it regardless of
  whether loops run yet; every `wt-*`/loop-pack script reads it
  unconditionally once dual-checkout is confirmed. Whether the loop pack is
  actually **active** is a separate question entirely, controlled by
  `loops.enabled` (which loops rotate — an explicit `[]` means "run
  nothing," never inferred, never silently defaulted to the full set) —
  ask that separately, and default to deferred (`loops.enabled` omitted or
  `[]`) unless the owner explicitly wants loops running now. Don't let one
  answer stand in for the other.
- **Worktrees** (usually confirm-not-ask — surface the resolved default,
  ask only if it needs overriding): `worktrees.root` defaults to
  `.worktrees` **inside** the repo (relative to the main checkout's root,
  resolved via `git rev-parse --git-common-dir` so it's stable regardless
  of which worktree the command happens to run from). Omit the key
  entirely rather than stamping it, unless the owner overrides it — the
  schema default already resolves to `.worktrees`, and omitting keeps
  future default changes flowing through (see "Validate before writing"
  below). This is worktree-topology aware on purpose: a project's
  prod/dev "checkouts" may be two independent clones, or two **linked
  worktrees sharing one `.git`** (real topology, not hypothetical — see
  step 1's dual-checkout detection); the wrong assumption here silently
  points `wt-start`/`wt-land`/etc. at the wrong directory. Confirm/correct
  `worktrees.root` (if overridden) and `worktrees.namePattern` (default
  `"agent/<slug>"`) explicitly — every `wt-*` command depends on both
  being right.
  - **Self-heal the gitignore entry.** Whatever `worktrees.root` resolves
    to (default `.worktrees`, or the owner's override if it's also inside
    the repo), ensure it's gitignored — call
    `plugin/scripts/agent-wt/maple-lib.sh`'s `maple_ensure_gitignored
    '<root>/'` (source the lib, then call it) rather than hand-rolling the
    append; it already handles CRLF tolerance and a missing trailing
    newline correctly. `maple-start.sh` also self-heals this on every run,
    so this step is a courtesy, not the only safety net.
  - **Stamp the tool-exclusion entries — detect-and-warn, don't
    silently skip.** A nested worktree under `.worktrees/` is a full
    source checkout; every tool that globs the whole tree (TypeScript,
    ESLint, a bundler, a docs-drift/index generator, a dependency-graph
    linter, test runners) will otherwise walk into it and can report
    phantom duplicates/collisions. This plugin cannot know every stack's
    config shape, so:
    - For configs this command recognizes on sight (`tsconfig.json`
      `exclude`, `.gitignore`, `eslint.config.*`/`.eslintrc*` ignores,
      `.dependency-cruiser.cjs`/`.js`/`.json` `exclude` if present) — add
      a `.worktrees` (or `**/.worktrees/**`, matching that tool's own
      idiom) entry directly, following the file's existing style.
    - For everything else — a test runner config, a bundler config, a
      project-specific docs/drift script under `scripts/` — **detect
      whether it globs the repo tree at all** (look for `readdir`, `glob`,
      `**/*`, or an explicit include/exclude list) and if so, **warn
      loudly in the step-8 report** rather than guessing at an edit: name
      the file, say it likely needs a `.worktrees` exclusion, and don't
      touch it. Never silently skip a file that clearly globs the tree —
      an unflagged one is worse than an unstamped one.
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

**Non-interactive fallback — `AskUserQuestion` unavailable.** This step's
ask assumes an interactive session. It isn't one when this command runs
headlessly (a delegated/background agent, a scheduled/cron invocation, or
any run with no human on the other end to answer) — `AskUserQuestion`
simply cannot be called. Detect this before attempting the ask, and switch
to:

- **Infer everything step 1 can safely and unambiguously detect**, exactly
  as the interactive path would.
- **For anything genuinely optional, default to the most conservative,
  reversible choice — never an active/committing one**: `ci.tiers.*` —
  omit rather than invent a command; `errorTracker.provider` — omit unless
  a tracker dependency is already unambiguously present in `package.json`;
  `loops.enabled` — omit/`[]` (deferred; never guess an active loop set,
  see [[decisions]] D006); `repo.standingLoopBranch` — the schema default
  (`"dev-burner"`) is safe to write even headlessly since it's inert until
  `loops.enabled` turns something on (see the repo-layout bullet above).
- **Never silently guess anything beyond that.** Every value this command
  picked without being asked — inferred or defaulted — must be recorded,
  not just used:
  1. In this run's own step-8 report, under an explicit **"Assumed
     (unconfirmed — headless run)"** list: the value, and the one-line
     reason it was picked.
  2. In a companion note at the project root, `maple.config.assumptions.md`
     — plain prose, never inside `maple.config.json` itself (the schema's
     `additionalProperties: false` leaves no room for an annotation key,
     and JSON has no comment syntax) — carrying the same list, so the
     owner sees it on a later pass over the repo even outside this
     session's output. If `docs/gaps.md` already exists (or gets created
     in step 3), also append one bullet there pointing at the note.
- **Fail loud** for anything step 1 leaves genuinely ambiguous with no safe
  default — an unresolved dual-checkout ambiguity, a `project.slug` that
  can't be inferred cleanly, conflicting sibling-repo signals. Stop the
  sequence there, write nothing, and report exactly what's blocking and
  what answer would unblock it — the same information an `AskUserQuestion`
  call would have needed. A later interactive run (or the owner editing
  the assumptions note directly and re-running) resolves it.

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
- **Docs gate red**: figure out WHICH docs the errors point at before
  deciding what to do — a freshly-scaffolded empty `docs/` and a real,
  already-populated one produce identically-shaped red gates but call for
  opposite responses:
  - **Errors on a file this run itself just wrote or just regenerated**
    (a page step 3 scaffolded because it didn't already exist, or the
    `.docs-index.json`/catalog block step 4 just generated) — that
    genuinely is this command's own bug, not the project's. Fix it (most
    likely: missing frontmatter, a stale `.docs-index.json` — re-run step
    4, `--fix` if it's index/catalog staleness) and re-check before
    reporting done.
  - **Errors on a page that already existed before this run** (a broken
    wikilink, an oversized decision/task/log entry, anything predating
    adoption) — against a real, already-populated `docs/` (this command's
    entire purpose, not an edge case) this is the common outcome, and it
    is genuine **pre-existing content debt**, not something adoption
    caused. **Report it verbatim in step 8 and stop there.** Optionally
    add a one-line pointer in `docs/gaps.md` for the owner to triage on
    their own schedule, but **never silently fix or rewrite existing real
    content** to force the gate green — the same "fill gaps, never edit
    existing content without approval" rule this command follows
    everywhere else applies here too.
  - A single run can show both kinds at once — split the report the same
    way: fix-and-reverify the adoption-caused errors, report-and-stop on
    the pre-existing ones.
- **CI tier red**: this is pre-existing project state, not something
  `/adopt-standard` caused — report the failure verbatim and stop; do not
  attempt to fix the project's own CI failures as part of adoption.

### 8. Report

Summarize: what was created, what was left alone, what's still missing, the
resolved `maple.config.json`, and the step-7 verification result — then
stop. Do not commit on the owner's behalf; that's their call.

## Adopting a project with existing docs

This command's actual purpose is bootstrapping a project that's already
alive — real history, real docs, real branch state — not a scratch/empty
clone. First real-world run (EasyCaller) surfaced a few things worth
stating explicitly, since "everything scaffolded, nothing broke" can look
suspiciously like "nothing happened":

- **Mostly no-op scaffolding is normal, and it's success, not failure.**
  Step 3 leaving `index.md`/`gaps.md`/`tasks.md`/`log.md`/`decisions.md`
  untouched because they already exist is the expected outcome against a
  real project with its own docs — report "left alone: N of 5, already
  present" as a normal, positive result, not a sign the step did nothing
  useful.
- **A red drift gate from pre-existing content debt is expected against a
  real docs/, and it must be reported, not fixed.** See step 7's "Docs gate
  red" split above — a broken wikilink or an oversized log entry that
  predates this run is real signal about the project's docs, surfaced by
  the gate the project just inherited; silently patching it would hide
  genuine debt from the owner instead of surfacing it.
- **Catalog generation (step 4) skips itself, quietly, when a project has
  no catalog markers.** `generate-docs-index.mjs` only maintains the
  generated block in `docs.index` between `<!-- catalog:begin -->`/
  `<!-- catalog:end -->` markers; a legacy-prose project that never
  adopted them reports `catalog: skipped (no <!-- catalog:begin/end -->
  markers in index.md)` — that's correct behavior (step 3 already says to
  skip adding the markers when matching a legacy prose project), not a
  step-4 failure. `docs/.docs-index.json` still gets written regardless —
  only the human-facing catalog block in `index.md` is affected.

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
