# Changelog

All notable changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); newest first. The
`docs-sync-reminder` hook nags when code changes land without an entry here.

## [Unreleased]

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
