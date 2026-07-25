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
| `docs.indexFile` | `"docs/.docs-index.json"` | machine-readable map: doc -> `Code:` anchor paths |
| `docs.driftScript` | `"scripts/check-docs-drift.mjs"` | structural checker (project-root-relative) |
| `docs.indexScript` | `"scripts/generate-docs-index.mjs"` | regenerates `docs.indexFile` |
| `docs.changelogFile` | `"CHANGELOG.md"` | |
| `docs.ephemeralPaths` | `[]` | doc-relative paths not owned by code (e.g. a session-state folder) — skip these in ownership resolution |

**Gap:** `docs.driftScript` / `docs.indexScript` are **not bundled with this
plugin** — they must already exist in the adopting project (this template
repo ships them at `scripts/check-docs-drift.mjs` /
`scripts/generate-docs-index.mjs`; `/adopt-standard` is expected to be the
place a future version copies them in for non-template projects, but that
port hasn't happened yet — see plugin/README.md "Gaps"). If the scripts
aren't present, do the semantic pass (steps 1-2 below) and skip steps 3-4,
noting the gap to the user.

## Arguments

`$ARGUMENTS` — optional scope:
- empty → sync the docs implicated by the current working tree (default).
- a path (e.g. `docs/architecture.md` or `src/hooks/`) → sync just the doc(s) owning that path.
- `--all` → full audit: every doc vs its `Code:` paths (use sparingly; heavy).

## How ownership is resolved

`docs.indexFile` maps each doc -> its `Code:` anchor paths. The reverse map
(code path -> owning doc) is what the `docs-sync-reminder` Stop hook prints.
A changed code file is "owned" by a doc when it sits under one of that doc's
anchor paths. Paths under any `docs.ephemeralPaths` entry are skipped — they
aren't owned by code.

## Steps

### 1. Scope
Run `git status --porcelain` for changed files (or take the `$ARGUMENTS`
path). Read `docs.indexFile`; for each changed code file, find docs whose
`anchor_paths` cover it. That set is your worklist.

### 2. Reconcile each implicated doc (the semantic pass)
For each doc on the worklist:
- Read the doc AND the current code at its anchor paths.
- Fix every claim the code contradicts — route tables, schema, function/RPC
  names, flags, fallback chains, phase status, file/symbol names.
  **Synthesize, don't append** — edit the relevant section, don't bolt on an
  "Update:" note. Stale = rewrite or delete; never leave a wrong claim.
- If the doc's `Code:` preamble paths moved/renamed, update them.

### 3. Triage the structural warnings
Run `node <docs.driftScript>` and resolve what it surfaces:
- **untracked doc** → commit it or delete it (no limbo).
- **not referenced in index.md** → add a one-line catalog entry under the right heading in `docs/index.md`, or delete the doc if it's dead.
- **unresolved wikilink [[X]]** → fix the link or remove it (the target doc was likely deleted).

### 4. Regenerate + verify
```
node <docs.driftScript> --fix     # regenerate docs.indexFile (or run <docs.indexScript> directly)
node <docs.driftScript>           # must end: 0 error(s)
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
