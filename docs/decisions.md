---
type: ledger
title: Decisions
description: decision ledger (`D###` entries, newest first). Check before re-litigating anything.
tags: [decisions, governance]
timestamp: 2026-07-25
audience: agents + owner. Read before asking; cite before asserting
authoritative_for: [every settled call. Newest first]
code: [node scripts/next-task-id.mjs --add --decision --title "..." --body "..."]
---
# Decisions

Each entry: `## D### | YYYY-MM-DD | title` + 1-2 sentences (≤600 chars,
gate-enforced). The call and its pointers only — detail lives in the
affected doc/code/CHANGELOG.

## D056 | 2026-09-16 | maple-standard lives at C:/Projects/Maple-Standard, not under Studio-Maple
The standard stopped being a Studio-Maple sub-project once Caller, MapleLens, Nekuda and VeHagita all consumed it; the nested path made it look like website-2's dependency. It is now a top-level sibling of the projects it serves. Studio-Maple never tracked it, so the move is a directory rename plus the marketplace path in ~/.claude/settings.json and known_marketplaces.json — which sync-plugin-cache.mjs (D053) self-heals by basename when it runs from a directory other than the registered one.

## D055 | 2026-09-16 | Worktrees live inside the repo at .worktrees/, not a sibling dir
worktrees.root now defaults to $MAPLE_MAIN_ROOT/.worktrees instead of ../<repo>-wt: a project is one filesystem path, nothing outside the checkout. maple_ensure_gitignored (generalized from the .loop-state helper) self-heals the entry on every wt-start/wt-preview/dev-burner; tsconfig/eslint/dep-cruiser exclude it. New hazard the sibling layout lacked: git clean -xffd deletes nested worktrees and follows their node_modules junctions into the main tree (D012) — blocked by bash-guard's clean-guard.

## D054 | 2026-09-16 | AskUserQuestion is the exception; ask inline and recommend
The owner's standing instruction flipped: a modal option menu stops the turn and makes him arbitrate. Default is now a plain inline question while work continues on everything not blocked by the answer; obvious calls are made, not asked. AskUserQuestion is reserved for genuinely branching decisions, and must contrast the options and mark exactly one (Recommended). Enforced by a pure Tier 0.5 in ask-gate.mjs that nudges once per question set when no single option is marked. ASK_GATE_MODALITY_DISABLE=1 opts out.

## D053 | 2026-09-16 | Plugin updates propagate via a SessionStart cache sync
A directory-source marketplace is COPIED into ~/.claude/plugins/cache/, not read live. The cache sat frozen at v0.1.0 (2026-07-27) while the repo reached v0.2.0 — every project ran July's plugin, masked by the stale ~/.claude duplicates D051 superseded (now in ~/.claude/backups/). sync-plugin-cache.mjs content-hashes plugin/ against the cache and re-mirrors on drift, driven from a ~/.claude/settings.json SessionStart hook: the plugin's own hooks.json ships inside the stale cache and cannot bootstrap itself.

## D052 | 2026-08-30 | Local Docker stacks are on-demand, never auto-start
supabase start stamps restart:unless-stopped on every container, so Docker Desktop resurrected entire stacks at every boot regardless of use (44 containers, 4 stacks, 36 running continuously, 2 stacks orphaned - 91.4GB reclaimed via image/volume/builder prune). No container carries a restart policy other than none; dstack up re-strips it after every supabase start; stack last-used = max(StartedAt,FinishedAt), idle >14d flagged by weekly /docker-audit, archived only on approval. See [[docker]].

## D051 | 2026-08-25 | Skills and session commands ship in the plugin, not ~/.claude
credential-manager lived in ~/.claude/skills and /todo /project-status /session-end /represent /review-aspect in ~/.claude/commands — machine-local, unversioned, invisible to a new machine or an adopting project. All six moved into plugin/skills/ and plugin/commands/. This narrows the user-global bucket [[standard-architecture]] describes to near-empty, by design: that bucket has no gate behind it. credential-manager was genericized to <Project>-<Service>-<Purpose> placeholders on the way in.

## D050 | 2026-08-25 | IDs are repo-global, not per-worktree
The #T/D/S allocator scanned only the current worktree's docs file and locked on a per-worktree `docs/tasks.md.lock`, so two parallel agent/<slug> sessions both issued the same id and only collided at /wt-land. Numbers now come from max(a counter in `<git-common-dir>/maple/id-counters.json`, a live `git worktree list` scan of every worktree's docs file) + 1, with the mutex moved to the same shared dir. Fails open to the old behaviour outside git. See [[standard-architecture]] and plugin/scripts/docs/lib/id-store.mjs.

## D012 | 2026-07-30 | Worktree teardown strips reparse points before deleting
git worktree remove --force follows NTFS junctions (empties the target, leaves the dir — sandbox-verified); Turbopack leaves .next/node_modules junctions targeting the main checkout's .pnpm dirs, which gutted maple-pole's node_modules 3x in 3 days (its D049). maple_remove_worktree now strips every link inside the worktree first (strip-reparse-points.ps1, a non-link-following walk); _maple_link_dir rmdirs an existing link before rm -rf. Regression: agent-wt/junction-safety.test.mjs, fast tier.

## D011 | 2026-07-25 | MapleLens lives in its own top-level repo, published private
C:/Projects/MapleLens is a standalone git repo, not a maple-standard package - a deployable product with its own release cadence; per-app instances pin versions of it. Published to github.com/maayanmar/MapleLens as PRIVATE until deployed and hardened; open-sourcing is a deliberate later call. Extraction from VeHagita is read-only on VeHagita and MapleLens stays independent of the plugin for now.

## D010 | 2026-07-25 | Docs system aligns with Google OKF v0.1
Full alignment: YAML frontmatter replaces the prose preamble (type/title/description/tags/timestamp + custom audience/authoritative_for/code fields), docs tooling reads frontmatter, index.md catalog is generated from description fields. Drift gate validates both wikilinks and markdown links. Scope: plugin docs tooling (#T13), VeHagita page migration (folded into #T5), MapleLens docs OKF-style from day one. Client-handoff use: not adopted for now.

## D009 | 2026-07-25 | First adoption target: EasyCaller, after plugin v1
Rollout order: plugin v1 -> EasyCaller (Caller-development) adoption -> VeHagita alignment (keeps /chaos and /heal-security project-local) -> MapleLens VeHagita deploy -> MapleLens EasyCaller deploy -> loops live on both. See [[rollout]] for per-step verification.

## D008 | 2026-07-25 | Repo layout standard: prod/dev dual checkouts
Standard assumes two checkouts of the same repo (e.g. Caller = prod, Caller-development = dev). /adopt-standard records this in maple.config.json layout block; the loop pack standing worktree operates against the dev checkout only. Bootstrap and loops must respect this, not assume single-checkout.

## D007 | 2026-07-25 | Loop-engineering principles baked into every loop
External verification only - the worker never grades its own homework; hard budget per loop; caught process mistakes become correction candidates queued for review, never self-applied. Loops never edit docs pages except /detect-drift scoped gaps.md append; /burn-backlog defers tasks.md checkoff to morning review.

## D006 | 2026-07-25 | Loop execution model: standing session, dev-burner branch
A standing local Claude Code session runs /loop self-paced over /dev-burner. No Telegram reporting. Loops work in an isolated worktree on a standing dev-burner branch; full gate tier before any commit lands on it; never merged without the owner explicit morning review and land.

## D005 | 2026-07-25 | Loop pack: four mid-development improvement loops
/sweep-errors (tracker triage + fix), /burn-backlog (small specced tasks), /sweep-quality (one verified improvement per cycle), /detect-drift (docs-vs-code drift to gaps.md proposals only). Target: VeHagita + EasyCaller mid-development work. See [[loop-pack]].

## D004 | 2026-07-25 | Error tracker generalized as MapleLens
Per-app deployed instances built from shared code extracted from VeHagita DIY tracker - design unchanged (agent-native, MCP-first, one-fetch issue context, bearer tokens, dual-send alongside free-tier Sentry). VeHagita deploys first; EasyCaller next. See [[maplelens]].

## D003 | 2026-07-25 | v1 plugin layers, scope boundary
v1 ships: worktree lifecycle (wt-*), generic safety hooks (deny-credential-paths, scrub-secrets, bash-guard, dirty-tree-guard, ask-gate, decision-reminder, docs-sync-reminder, parallel-session-warn), docs gate + decision integrity, parameterized /heal. Project-specific hooks (eslint-fix, size-warning, build-counter) stay template/per-project side.

## D002 | 2026-07-25 | Standard delivery is a hybrid, not one artifact
The maple-standard machinery splits four ways: a Claude Code plugin (stack-agnostic commands/hooks/agents/loop pack), truly-universal bits at user-global ~/.claude, an /adopt-standard bootstrap stamping per-project files (maple.config.json, docs skeleton, CLAUDE.md skeleton), and this template repo kept as-is for greenfield projects. See [[standard-architecture]].

## D001 | 2026-07-15 | Template baseline
This project is instantiated from maple-standard: Next.js (App Router) +
TypeScript + Supabase + Vercel, quality framework enforced by mechanism
(hooks, tiered gates, CI). Framework changes are decisions — log them here.
