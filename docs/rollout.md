---
type: spec
title: Rollout — ordered plan from plugin v1 to loops live everywhere
description: "ordered rollout plan (plugin v1 → EasyCaller → VeHagita → MapleLens → loops live) with per-step verification."
tags: [rollout, plan]
timestamp: 2026-07-25
audience: whoever is executing or checking progress on the standard's rollout
authoritative_for: [step order, and what "adopted correctly" means at each step]
code: []
reference_for: rollout execution across VeHagita / Caller / Caller-development — no owned code paths in this repo
---
# Rollout — ordered plan from plugin v1 to loops live everywhere

> **Status:** Approved 2026-07-25 (owner sign-off). Spec for plugin v1 — implementation tracked in [[tasks]] and [[decisions]].
> **Related:** [[standard-architecture]] · [[loop-pack]] · [[maplelens]]

Six steps, strictly ordered — each depends on the previous one's verification passing, not on a calendar date. No step self-declares done; each ends with a check anyone can re-run.

## 1. Plugin v1 ships

**What:** the maple-standard plugin exists and is installable — v1-layer commands (`wt-*`, generic safety hooks, parameterized `/heal`), the loop pack, and `/adopt-standard`, packaged per [[standard-architecture]].

**Verify adopted correctly:**
- `/adopt-standard` run against a scratch/throwaway clone produces a `maple.config.json` that validates against the schema, a `docs/` skeleton, and a passing docs-drift gate — on the first try, no manual patching.
- Every plugin command runs without error against that scratch project (`wt-start` → `wt-land` round-trip on a trivial change; each generic hook fires on its trigger — spot-check `deny-credential-paths` blocks a `.env` read, `decision-reminder` nudges on decision language).

## 2. EasyCaller adoption (`Caller-development`)

**What:** run `/adopt-standard` against `Caller-development` — the dev checkout, per the dual-checkout layout (decision 7). First real (non-scratch) adoption target, per decision 8.

**Verify adopted correctly:**
- `maple.config.json` reflects the real layout: `prodCheckout` = `C:/Projects/Caller`, `devCheckout` = `C:/Projects/Caller-development`, real branch names.
- Docs-drift gate green on the stamped `docs/` skeleton.
- `wt-start` → make a trivial change → `wt-land` completes end-to-end, gate included, without `--no-verify` or any bypass.
- Hooks wired into `.claude/settings.json` without clobbering anything EasyCaller already had there.

## 3. VeHagita alignment (keeps its extras)

**What:** VeHagita already runs its own `wt-*`, hooks, `/heal`, `/heal-security`, `/sync-docs`, `/chaos` — predating the plugin. It adopts the plugin's generalized versions where they're genuine equivalents; anything with no plugin equivalent yet stays project-local. `/heal-security` (multi-agent nightly security audit) and `/chaos` (local chaos→fix→verify harness) have no generalized counterpart in v1 — they are VeHagita-specific and stay exactly where they are.

**Verify adopted correctly:**
- VeHagita's existing gate tier is still green after swapping in plugin-equivalent commands (`wt-*`, the generic hooks, `/heal`) — no regression from the swap.
- `/chaos` and `/heal-security` are untouched and still runnable as-is.
- VeHagita's `CLAUDE.md` still accurately describes its real stack (Remix/CF/Supabase) — the plugin's generic skeleton is merged in, not pasted over the project-specific content.

## 4. MapleLens — VeHagita deploy

**What:** execute the (generalized) MapleLens deployment runbook against VeHagita's already-committed, undeployed `cloudflare/error-tracker/` — provision CF resources, set secrets via the credential-manager skill, apply migrations, deploy, smoke test, register the MCP server, start the soak. This happens in its own session, out of scope for the session that produced this spec.

**Verify adopted correctly:**
- Smoke test passes: unauthed `/v1/health` returns 200; a thrown test error appears in `/v1/issues` within ~5s **and** still lands in Sentry (dual-send confirmed, nothing regressed).
- MCP tools (`errors.list_issues`, `errors.get_issue`, ...) are callable from a fresh Claude Code session, no fallback to Sentry MCP needed for a real investigation.
- `maple.config.json` `errorTracker.provider` flips from `"sentry"` to `"maplelens"` for VeHagita.

## 5. MapleLens — EasyCaller deploy

**What:** same runbook, second instance, EasyCaller's own CF resources/domain/tokens — requires `maplelens-core` extraction (see [[maplelens]]) to have already happened, since this is the first non-VeHagita instance built from the shared package rather than the original code.

**Verify adopted correctly:**
- Same smoke-test pattern as step 4, run against EasyCaller's own domain/tokens.
- Resource names (D1 database, R2 buckets, AE datasets) don't collide with VeHagita's instance — confirm namespacing held.
- EasyCaller's `maple.config.json` `errorTracker.provider` flips to `"maplelens"`.

## 6. Loops live on both

**What:** enable the standing `/dev-burner` session for VeHagita and for EasyCaller (`Caller-development`), each with its own `dev-burner` branch, its own `.loop-state/` directory, and `errorTracker.provider` already pointed at MapleLens from steps 4–5.

**Verify adopted correctly:**
- First morning review on each project shows a non-empty, sensible `.loop-state/dev-burner-ledger.jsonl` — real cycles ran, real loops were picked.
- At least one full loop cycle passed the gate tier end-to-end with no human intervention overnight.
- `development` is untouched by the overnight run — `dev-burner` sits ahead of it, unmerged, waiting on Maayan's explicit land.
