---
description: Reconcile docs/ with the code (the docs-drift executor)
---

# /sync-docs — Reconcile docs/ with the code

Bring the wiki back in sync with reality. This is the **executor** the
docs-drift gate and the `docs-sync-reminder` Stop hook point you to.
Structural checks are automated; **semantic** sync — prose that describes
superseded behavior while its `Code:` paths still resolve — is the part
only this pass can do.

## Config this command reads (`maple.config.json` at project root)

| Key | Default | Notes |
|---|---|---|
| `docs.root` | `"docs"` | the wiki folder (may be flat or nested — `docs/index.md` + topic pages, or `docs/{system,features,...}/`) |
| `docs.docsIndexJson` | `"docs/.docs-index.json"` | machine-readable map: doc -> owned-paths (`code`) |
| `docs.index` | `"docs/index.md"` | the catalog page (generated Catalog block, D010) |
| `docs.tasks` / `docs.decisions` / `docs.log` / `docs.gaps` | `"docs/tasks.md"` / `"docs/decisions.md"` / `"docs/log.md"` / `"docs/gaps.md"` | the state files the gate entry-length-caps |
| `docs.ephemeralPaths` | `[]` | doc-relative paths not owned by code (e.g. a session-state folder) — skip these in ownership resolution |

Structural checking runs `plugin/scripts/docs/check-docs-drift.mjs` and
`generate-docs-index.mjs` **bundled with this plugin** (#T13 — no
project-side copy needed; a project's own `scripts/check-docs-drift.mjs`,
if it has one from before adopting the plugin, can stay as a thin delegate
to the bundled version, same pattern as this template repo's own
`scripts/*.mjs`). Both are frontmatter-aware (OKF v0.1, docs/decisions.md
D010) with a legacy-prose fallback — see plugin/README.md's "Bundled docs
tooling" section for the full `docs.*` key set they read.

## Arguments

`$ARGUMENTS` — optional scope:
- empty → sync the docs implicated by the current working tree (default).
- a path (e.g. `docs/architecture.md` or `src/hooks/`) → sync just the doc(s) owning that path.
- `--all` → full audit: every doc vs its `Code:` paths (use sparingly; heavy).

## How ownership is resolved

`docs.docsIndexJson` maps each doc -> its `code` anchor paths (frontmatter
`code`, or the legacy `**Code:**`/`**Enforced by:**` preamble on an
unmigrated page). The reverse map (code path -> owning doc) is what the
`docs-sync-reminder` Stop hook prints. A changed code file is "owned" by a
doc when it sits under one of that doc's anchor paths. Paths under any
`docs.ephemeralPaths` entry are skipped — they aren't owned by code.

## Steps

### 1. Scope
Run `git status --porcelain` for changed files (or take the `$ARGUMENTS`
path). Read `docs.docsIndexJson`; for each changed code file, find docs whose
`anchor_paths` cover it. That set is your worklist.

### 2. Reconcile each implicated doc (the semantic pass)
For each doc on the worklist:
- Read the doc AND the current code at its anchor paths.
- Fix every claim the code contradicts — route tables, schema, function/RPC
  names, flags, fallback chains, phase status, file/symbol names.
  **Synthesize, don't append** — edit the relevant section, don't bolt on an
  "Update:" note. Stale = rewrite or delete; never leave a wrong claim.
- If the doc's frontmatter `code` (or legacy `Code:` preamble) paths
  moved/renamed, update them. A page with a `description` in frontmatter
  joins the generated Catalog automatically on the next regenerate — no
  manual catalog edit needed (D010).

### 3. Triage the structural warnings
Run `node plugin/scripts/docs/check-docs-drift.mjs` (or the project's own
delegate, e.g. this template's `node scripts/check-docs-drift.mjs`) and
resolve what it surfaces:
- **untracked doc** → commit it or delete it (no limbo).
- **Catalog block is stale** → run with `--fix` (it's generated from
  frontmatter `description`, not hand-edited — see docs/index.md's
  Conventions section) — or delete the doc if it's dead.
- **unresolved wikilink [[X]]** / **unresolved relative link** → fix the
  link or remove it (the target doc was likely deleted or renamed).
- **legacy prose preamble** → migrate the page to OKF v0.1 frontmatter when
  you're already touching it (not required to clear this pass — it's
  migration pressure, not a blocker).

### 4. Regenerate + verify
```
node plugin/scripts/docs/check-docs-drift.mjs --fix   # regenerate docs.docsIndexJson + the docs.index catalog
node plugin/scripts/docs/check-docs-drift.mjs          # must end: 0 error(s)
```
Errors block the pre-push gate — drive them to zero. Warnings are review
signals; clear the ones in scope.

### 5. CHANGELOG
Add an entry under `[Unreleased]` in `docs.changelogFile` for any behavior
change you documented (Features / Fixes / Refactoring / Docs).

### 6. Approval (do NOT self-declare done)
Wiki updates require the owner's approval. Present a concise summary of the
doc changes — which docs, what drifted, what you corrected — and let them
review before commit. Don't commit unless told to.

## Anti-patterns
- Don't `--fix` the index without doing the semantic pass first — a green
  structural check on stale prose is the exact trap that causes drift to
  compound.
- Don't add placeholder/"TODO: document" entries.
- Don't raise the docs-drift gate's tolerance to make it pass. The gate only
  ratchets down.

## Gap vs. the VeHagita original

The source command (`VeHagita/.claude/commands/sync-docs.md`) hardcoded a
nested `docs/{system,features,quality,dev,learning,state}/` layout and
called out `docs/state/*` as ephemeral by name. This version treats the
docs folder shape as config (`docs.root`, `docs.ephemeralPaths`) so it works
for both a flat layout (this template's own `docs/`) and a nested one.

**Docs tooling is now bundled (#T13).** The structural checker/generator
used to be "must already exist in the project" — as of D010 they ship at
`plugin/scripts/docs/{check-docs-drift,generate-docs-index}.mjs`, generic
and config-driven, so this command works out of the box on a fresh
`/adopt-standard` bootstrap with no project-side script copy required.
