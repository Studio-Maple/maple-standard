---
type: spec
title: MapleLens — generalizing the DIY error tracker
description: "MapleLens error tracker: shared core vs. per-instance config, deploy runbook, the MCP contract `/sweep-errors` reads."
tags: [maplelens, error-tracker]
timestamp: 2026-07-26
audience: anyone deploying a new per-app MapleLens instance, or auditing what the extraction shipped
authoritative_for: [what's shared vs. per-instance, the deployment story per app, and the MCP contract /sweep-errors depends on]
code: []
reference_for: the maplelens extraction (done 2026-07-26) — shared code lives in the external MapleLens repo (C:/Projects/MapleLens, branch extraction); no owned paths in this repo
---
# MapleLens — generalizing the DIY error tracker

> **Status:** Extraction **done** 2026-07-26 (spec approved 2026-07-25). The shared code shipped in the standalone **MapleLens repo** — `C:/Projects/MapleLens`, branch `extraction` (own repo per D011 in [[decisions]]; execution logged in MapleLens `docs/log.md` S002, per-task notes in its `docs/tasks.md` #T1–#T7). This page records what actually shipped. Deploys are still pending — VeHagita first, EasyCaller second, see [[rollout]].
> **Source design:** VeHagita `docs/features/diy-error-tracker/roadmap.md` + `deployment.md` (agent-native, MCP-first, dual-send with free-tier Sentry — carried over verbatim, not redesigned).
> **Related:** [[standard-architecture]] (`errorTracker` block in `maple.config.json`) · [[loop-pack]] (`/sweep-errors`) · [[rollout]]

**MapleLens** is the name for per-app deployed instances of VeHagita's DIY error tracker, built from shared code in the standalone MapleLens repo (the `maplelens-core` working name is retired — it's a repo, not a maple-standard package, per D011). Nothing about the design was reopened: the extraction ported VeHagita's `cloudflare/error-tracker/` as-is, parameterized instead of hardcoded. VeHagita deploys its own instance first, in a separate session; EasyCaller is next.

## Design carried over unchanged

- **Agent-native, MCP-first.** The MCP server is the canonical interface, same tool shape as the Sentry MCP tools it can stand in for.
- **Rich JSON API alongside** for `/heal`-equivalents, cron, and non-MCP callers — every MCP tool has a parallel `GET /v1/...`.
- **One-fetch issue context.** `errors.get_issue` / `GET /v1/issues/:fp/full-context` returns issue meta + symbolicated latest event + breadcrumbs + similar issues + suspect files + suspect commits + user context in a single call.
- **Bearer-token auth**, two scopes: `READ_TOKEN` (liberal — agents, cron, terminals) and `WRITE_TOKEN` (conservative — mutations only).
- **Dual-send alongside free-tier Sentry**, indefinitely. Sentry is the independent, zero-cost safety net for "who watches the watcher," not a migration target to drop.

## What shipped in the shared core

The extraction ported **all** of VeHagita's `cloudflare/error-tracker/` — 19 worker modules + 6 D1 migrations, the MCP server, and the SDK transport — zero VeHagita strings left in code, `tsc --noEmit` clean across all three packages, all ported tests passing. Repo layout: `core/` (the CF Worker), `mcp/` (the MCP server), `sdk/` (client transport reference pattern), `instances/example/` (per-instance config + runbook template).

Four shipped phases were missing from the pre-extraction version of this table — regression detection, Telegram alerts, perf/AE-SQL queries, replay ingestion. All four were ported; they're marked below.

| VeHagita source (`cloudflare/error-tracker/`) | Shipped as (MapleLens repo) | Parameterization |
|---|---|---|
| `worker.ts` (envelope receive, routing) + `parse-envelope.ts`, `cors.ts`, `types.ts` | `core/worker.ts`, `core/parse-envelope.ts`, `core/cors.ts`, `core/types.ts` | Allowed origins + self-monitoring DSN env-driven; rate limits per instance |
| `fingerprint.ts` | `core/fingerprint.ts` — as-is | None — the algorithm is app-agnostic |
| `migrations.ts` + `migrations/*.sql` (6 — there was never a separate `d1-schema.sql`) | `core/migrations.ts` + `core/migrations/0001`–`0006` verbatim | D1 binding in the instance's `wrangler.toml` |
| AE dataset writers (`build-datapoint.ts`, `breadcrumbs.ts`, `spans.ts`) | `core/build-datapoint.ts`, `core/breadcrumbs.ts`, `core/spans.ts` | Dataset names are per-instance `wrangler.toml` bindings — unique per CF account |
| Source-map symbolication (`symbolicate.ts`) | `core/symbolicate.ts` | R2 bucket binding |
| `api-routes.ts` + `issues-store.ts`, `auth.ts` (the full JSON API surface) | `core/api-routes.ts`, `core/issues-store.ts`, `core/auth.ts` | Generic once auth/domain are parameterized |
| Suspect files/commits enrichment — lives inside `full-context.ts` (the `code-context.ts` this table used to name never existed as its own file) | `core/full-context.ts` | Release→commits manifest push stays in each app's own deploy script, feeding the same shared join logic |
| `regression.ts` — regression detection *(ported; absent from the pre-extraction table)* | `core/regression.ts` | None |
| `alerts.ts` — Telegram alerts *(ported; absent from the pre-extraction table)* | `core/alerts.ts` + migration `0005_create_alert_log.sql` | Bot token + chat ID per instance |
| `perf-queries.ts` + `ae-query.ts` — perf / AE SQL queries *(ported; absent from the pre-extraction table)* | `core/perf-queries.ts`, `core/ae-query.ts` | CF Analytics API token per instance |
| `replays.ts` — replay ingestion *(ported; absent from the pre-extraction table)* | `core/replays.ts` + migration `0006_phase8_replay_metadata.sql` | R2 replay bucket binding |
| `mcp-servers/errors/` | `mcp/` package — 15 `errors.*` tools (full inventory in `mcp/README.md`) | Env vars are `MAPLELENS_API_URL` / `MAPLELENS_READ_TOKEN` / `MAPLELENS_WRITE_TOKEN` (+ optional `MAPLELENS_ADMIN_URL`) — fixed names carrying per-instance values at MCP registration, **two tokens, not the single `<APP>_ERRORS_TOKEN` this table used to imply** |
| Frontend SDK fan-out shim (`errorTrackingDiyTransport.ts`) | **Two files, copy-in reference pattern** (not an importable package): `sdk/transport.ts` (`buildDiyTransport`) + `sdk/endpoints-reference.ts` (`createDiyEndpointRouter`), adaptation guide in `sdk/README.md` | Per app: Sentry SDK flavor, `serializeEnvelope` import, production hostnames + `/v1/envelope` endpoint |

## What stays per-instance config

Not extracted — lives in each app's own deploy config / secrets. The documented surface is `instances/example/wrangler.toml` (fully commented) + Worker secrets, per the shipped runbook:

- Custom domain (`errors-api.<app>.<domain>`, one per app).
- D1 database ID, R2 bucket names, AE dataset names — `wrangler.toml` bindings, namespaced so two apps' instances never collide even under one CF account.
- `READ_TOKEN` / `WRITE_TOKEN` — generated per instance, retrieved via the credential-manager skill at deploy/config time, never written to a file or echoed in chat (per the standard's secrets-handling rule, unchanged from both source projects).
- Telegram bot token + chat ID — reuse an existing bot with per-app chat routing, or a distinct bot per app; either way it's config, not code.
- CF Analytics API token — read scope for the perf/AE-SQL queries.
- Allowed origins — the app's own frontend domain(s), env-driven.
- Optional admin/dashboard host (`MAPLELENS_ADMIN_URL` on the MCP side) for the replay hand-off tool; without it the tool degrades gracefully.
- Source-map upload wiring — hooked into whatever build tool the app uses (Vite/Remix for VeHagita; EasyCaller's equivalent, TBD at its deploy step).
- Sentry fallback project ref — the app's own free-tier Sentry project for dual-send.
- All of the above surface through `maple.config.json`'s `errorTracker` block (see [[standard-architecture]]) — `provider`, `endpoint`, `readTokenRef`, `writeTokenRef`, `sentryProject`.

## Deployment story per app

The generalized runbook shipped: `instances/example/RUNBOOK.md` in the MapleLens repo — the same 9 steps as VeHagita's `deployment.md`, stack-agnostic, parameterized the same way as the code:

1. Provision CF resources (D1, R2 buckets) — namespaced per app.
2. Wire the generated D1 `database_id` into that app's Worker config (not a secret — safe to commit).
3. Set Worker secrets (`READ_TOKEN`, `WRITE_TOKEN`, Telegram creds, CF Analytics token) via the credential-manager skill — Maayan runs the `wrangler secret put` prompts himself, reports success only.
4. Apply D1 migrations.
5. Deploy; verify the custom domain resolves to the right Worker (VeHagita's runbook flags this as the one genuinely fiddly step — env-suffixed worker names can silently split from the intended custom domain).
6. Smoke test: unauthed health check, authed read, a thrown test error visible in `/v1/issues` within ~5s (and still landing in Sentry — dual-send confirmed).
7. Register the MCP server in the relevant `~/.claude/settings.json` / project MCP config (`MAPLELENS_API_URL` + tokens).
8. Wire source-map upload into that app's post-build step.
9. Start the soak (parity check vs. Sentry) as a confidence exercise — not a drop-gate, per VeHagita's own Phase 10 rescoping. Sentry never goes away.

VeHagita's own execution of this runbook happens in a separate session — see [[rollout]] for where it sits in the ordered plan. EasyCaller's deploy follows the same template; its extraction prerequisite is now met.

## How `/sweep-errors` consumes MapleLens

`maple.config.json` `errorTracker.provider` selects `"maplelens"` once an app's instance is live, `"sentry"` until then — `/sweep-errors` reads this, not a hardcoded assumption.

The shipped MCP server registers 15 tools (events, symbolication, replay hand-off, and perf drill-downs beyond the contract below — see `mcp/README.md`); `/sweep-errors` relies on this subset:

| Tool | Used for |
|---|---|
| `errors.list_issues` | Pull unresolved issues to cluster (the loop's first step). |
| `errors.get_issue` | One-fetch full context per actionable cluster — stack, breadcrumbs, suspect files/commits, similar issues. |
| `errors.diff_since` | Bound each cycle to what's new since the loop's last run, not a full re-scan. |
| `errors.search_code_path` | Pre-edit check — is the file about to be touched already implicated in an open issue. |
| `errors.resolve` / `errors.ignore` (shipped alongside `errors.assign`) | Final step after a fix's regression test passes the gate — `MAPLELENS_WRITE_TOKEN`-gated, same permission-note discipline as VeHagita's `/heal` (external write, request approval if not pre-approved). |

Until an app's MapleLens instance is deployed, the same loop logic runs against that app's Sentry MCP tools instead (`search_issues` / `get_sentry_resource`) — the clustering and verification-ladder logic in `/sweep-errors` is written against the tool *contract*, not against MapleLens specifically, so the provider swap is a config change, not a rewrite.
