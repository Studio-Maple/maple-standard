# docs/ — project knowledge base

> **Audience:** everyone (humans in Obsidian, agents at session start).
> **Authoritative for:** the docs catalog and cross-linking conventions.
> **Machine-readable:** `docs/.docs-index.json` (regenerate: `pnpm docs:index`)

Start here every session. This folder is the project's ground truth for
decisions, open work, and flagged gaps — Obsidian-compatible ([[wikilinks]],
cross-linked pages), drift-gated by `scripts/check-docs-drift.mjs`.

## Catalog

- [[decisions]] — decision ledger (`D###` entries, newest first). Check before re-litigating anything.
- [[tasks]] — open tasks only (`#T###`). Done tasks are swept; the record lives in CHANGELOG/git.
- [[gaps]] — things the owner flagged as missing or wrong. Check at session start.
- [[log]] — append-only session history (`S###`, 1-2 sentences each).
- [[quality]] — the enforcement matrix: every gate/hook, what it enforces, where it runs.

## Conventions

- Every topic page opens with a preamble blockquote: `**Audience:**`,
  `**Authoritative for:**`, and a `**Code:**` anchor listing owned paths.
  The drift gate errors on dead `Code:` paths and the docs-sync-reminder
  hook uses them to reverse-map code changes to owning docs.
- IDs (`#T###`, `D###`, `S###`) are ALLOCATED, never guessed:
  `node scripts/next-task-id.mjs [--decision|--session] [--add ...]`.
- Entries in decisions/tasks/log are capped at 600 chars (gate-enforced) —
  detail belongs in the owning topic page, CHANGELOG, or code.
- Grow this folder as the project grows (architecture.md, integrations.md,
  feature specs...) — add each new page to this catalog.
