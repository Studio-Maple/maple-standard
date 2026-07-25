---
description: Bootstrap an existing project onto the maple-standard (config + docs scaffold)
---

# /adopt-standard — Bootstrap the maple-standard onto this project

Stamp `maple.config.json`, scaffold the canonical `docs/` files if they
don't exist, and generate the docs index — so an **existing** project (not
a fresh clone of the maple-standard template) can use every other command
and hook in this plugin. Idempotent: never overwrite a file that already
has real content; only fill in what's missing.

## What this command writes

- `maple.config.json` at the project root (interactive — see step 1).
- `docs/index.md`, `docs/gaps.md`, `docs/tasks.md`, `docs/log.md`,
  `docs/decisions.md` — only the ones that don't already exist.
- `CLAUDE.md` at the project root — only if it doesn't already exist (a
  minimal skeleton, not this template's full charter — the project's own
  stack/workflow specifics belong there, written by the owner or a
  follow-up session).
- `docs/.docs-index.json` — regenerated via the configured index script.

## Steps

### 1. Detect current state

Check for: existing `maple.config.json`, existing `docs/` folder (and which
of the five canonical files already exist), existing `CLAUDE.md`, the
project's default git branch (`git symbolic-ref refs/remotes/origin/HEAD`),
and whether `package.json` exists (informs dev-command / gate-command
guesses).

### 2. Ask the owner (one `AskUserQuestion` call, multi-select + free-write option)

Only ask what can't be safely defaulted or detected. Cover at least:
- **Worktree layout**: single-checkout (default — `/wt-start` worktrees live
  in a sibling `<repo>-wt/` dir, ephemeral) vs. **dual-checkout** (there is
  also a persistent second checkout — e.g. `<repo>-dev/` — tracking a
  long-lived development branch, distinct from ephemeral agent worktrees;
  this is where `/dev-burner` and similar standing work happens before it
  lands). If dual-checkout: ask for the dev checkout's path/branch: this
  command **records** the convention in config but does **not** create the
  second checkout itself (creating a persistent git checkout is a
  deliberate act the owner should do by hand — `git worktree add
  <path> -b <branch>` — or via `/wt-start` semantics adapted to a
  non-ephemeral branch).
- **Target/integration branch** (default: detected origin default branch, else `main`).
- **Error tracker**: none / Sentry / maplelens — and its org/project/endpoint if any.
- **Gate commands** for `worktree.gate.tiers.*` (guess from `package.json`
  scripts if they follow the `ci:fast`/`ci:gate`/`ci:core` convention;
  otherwise ask).

Always leave a free-write option at the bottom for anything not covered.

### 3. Write `maple.config.json`

Merge the owner's answers with this plugin's defaults (see
`plugin/README.md` for the full schema) — write only the keys that differ
from default, to keep the file short and let future default changes flow
through. If a `maple.config.json` already exists, show the diff and confirm
before overwriting (never silently clobber owner-tuned config).

### 4. Scaffold `docs/`

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
  this command just created.
- `gaps.md` — flat bullet list, "(none yet)" placeholder.
- `tasks.md` — `## Inbox` / `## In progress` / `## Blocked` headings, empty.
- `log.md` — append-only session history, empty with a one-line header
  comment explaining the format (`## SXXX | YYYY-MM-DD | title`).
- `decisions.md` — one `D001` entry recording "adopted maple-standard via
  /adopt-standard on <date>" so the ledger has a baseline, same spirit as
  this template's own `docs/decisions.md` D001.

### 5. Scaffold `CLAUDE.md` (only if missing)

A minimal skeleton — audience, one-paragraph project description
placeholder, a pointer to `docs/index.md` for session start, and a note
that this plugin's hooks + commands are active. Do **not** copy this
template's full charter (long-run-over-patches rules, stack table, etc.)
verbatim — that content is opinionated to *this* template's Next.js/Supabase
stack; a `CLAUDE.md` for an arbitrary adopting project needs its own
description of its own stack and workflow, written by the owner or a
dedicated follow-up session, not invented here.

### 6. Generate the docs index

Run `node plugin/scripts/docs/generate-docs-index.mjs` (bundled with the
plugin — #T13, no project-side copy needed) to produce `docs.docsIndexJson`
(default `docs/.docs-index.json`) and, if `docs.index` already has
`<!-- catalog:begin -->`/`<!-- catalog:end -->` markers, the generated
Catalog block too. It's frontmatter-aware (OKF v0.1, docs/decisions.md
D010) with a legacy-prose fallback, so this works whether or not the
scaffolded pages have frontmatter yet.

### 7. Report

Summarize: what was created, what was left alone, what's still missing
(e.g. the docs-index scripts), and the resolved `maple.config.json` — then
stop. Do not commit on the owner's behalf; that's their call.

## Gap: the "prod/dev dual-checkout" layout standard

This is a new convention this bootstrap needs to respect per the plugin's
design brief, but it isn't documented anywhere yet — there's no existing
Studio Maple doc defining exactly what a "dual-checkout" project looks like
beyond what's described in step 2 above (a persistent second checkout for
standing dev work, alongside the primary/prod checkout, distinct from
`/wt-start`'s ephemeral worktrees). Treat the description in step 2 as the
working definition until a real spec supersedes it, and flag that gap to
the owner the first time `/adopt-standard` runs in dual-checkout mode.
