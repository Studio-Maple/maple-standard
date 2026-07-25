# Tasks

> **Audience:** agents + owner. Open work only — sweep done entries.
> **Authoritative for:** tracked future work (`#T###`).
> **Updated by:** `node scripts/next-task-id.mjs --add --section "Inbox" --title "..." --body "..."`

One bullet per task, ≤600 chars (gate-enforced): `- [ ] **#T### — title.** body`.
A `#T` is for real future work, not a band-aid over rot you could fix now.

## Inbox

- [ ] **#T13 — Bundle generic docs tooling into the plugin.** check-docs-drift.mjs + generate-docs-index.mjs are referenced by config but not bundled - non-template adopters have no copies. Generalize and ship them in plugin/scripts/.

- [ ] **#T12 — Harden generic safety hooks in the plugin.** Ported: deny-credential-paths, scrub-secrets, bash-guard, dirty-tree-guard, ask-gate, decision-reminder, docs-sync-reminder, parallel-session-warn. Verify each fires correctly from plugin context on a scratch project.

- [ ] **#T11 — Build /adopt-standard + maple.config.json schema validator.** Bootstrap per the adoption sequence in [[standard-architecture]]; schema validation before any file is written; skeleton stub exists.

- [ ] **#T10 — Finish wt-start/wt-land/wt-preview/wt-reap port.** Skeleton ported the worktree/lock/link mechanics; close the flagged gaps: no-default gate command per project, Supabase-CLI workaround documented per-project in tier command strings.

- [ ] **#T9 — Generalize /heal to be tracker-agnostic.** Sentry + MapleLens providers selected by maple.config.json errorTracker.provider; verification ladder pattern preserved.

- [ ] **#T8 — Build the loop pack.** Implement /sweep-errors, /burn-backlog, /sweep-quality, /detect-drift, /dev-burner orchestrator per [[loop-pack]] - the plugin currently ships stubs.

- [ ] **#T7 — Extract maplelens-core from VeHagita cloudflare/error-tracker.** Parameterize domain/D1/R2/AE-dataset names, tokens, Telegram config, allowed origins per the extraction table in [[maplelens]].

- [ ] **#T6 — Adopt the standard on EasyCaller (Caller-development).** Run /adopt-standard; verify per [[rollout]] step 2.

- [ ] **#T5 — VeHagita alignment pass.** Swap in plugin equivalents where they exist; confirm /chaos + /heal-security stay project-local; verify per [[rollout]] step 3.

- [ ] **#T4 — Deploy MapleLens for VeHagita.** Execute the deployment runbook (separate session) against the already-committed cloudflare/error-tracker/; verify per [[rollout]] step 4.

- [ ] **#T3 — Deploy MapleLens for EasyCaller.** Second instance from maplelens-core (extraction must be done first); verify per [[rollout]] step 5, including resource-namespace collision check.

- [ ] **#T2 — Turn on dev-burner loops for VeHagita and EasyCaller.** Standing session + /dev-burner on both; verify per [[rollout]] step 6. Requires all prior rollout steps green.

- [ ] **#T1 — Complete per-project instantiation.** Work through the README "Instantiate a new project" checklist: rename, Supabase project, Vercel project, Sentry DSN, GitHub secrets. Delete this task when done.

## In progress

## Blocked
