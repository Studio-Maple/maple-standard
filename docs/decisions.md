# Decisions

> **Audience:** agents + owner. Read before asking; cite before asserting.
> **Authoritative for:** every settled call. Newest first.
> **Updated by:** `node scripts/next-task-id.mjs --add --decision --title "..." --body "..."`

Each entry: `## D### | YYYY-MM-DD | title` + 1-2 sentences (≤600 chars,
gate-enforced). The call and its pointers only — detail lives in the
affected doc/code/CHANGELOG.

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
