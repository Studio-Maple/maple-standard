# MapleLens — generalizing the DIY error tracker

> **Audience:** anyone extracting shared code from VeHagita's tracker, or deploying a new per-app instance.
> **Authoritative for:** what's shared vs. per-instance, the deployment story per app, and the MCP contract `/sweep-errors` depends on.
> **Reference for:** `maplelens-core` extraction from VeHagita's `cloudflare/error-tracker/` (external repo — extraction is #T7; no owned paths here yet)
> **Status:** Approved 2026-07-25 (owner sign-off). Spec for plugin v1 — implementation tracked in [[tasks]] and [[decisions]].
> **Source design:** VeHagita `docs/features/diy-error-tracker/roadmap.md` + `deployment.md` (agent-native, MCP-first, dual-send with free-tier Sentry — carried over verbatim, not redesigned).
> **Related:** [[standard-architecture]] (`errorTracker` block in `maple.config.json`) · [[loop-pack]] (`/sweep-errors`) · [[rollout]]

**MapleLens** is the name for per-app deployed instances of VeHagita's DIY error tracker, built from shared code living in the maple-standard ecosystem. Nothing about the design is being reopened here — this is an extraction plan, not a redesign. VeHagita deploys its own instance first, in a separate session (Phases 0–9 are already committed, undeployed — see the runbook). EasyCaller is next.

## Design carried over unchanged

- **Agent-native, MCP-first.** The MCP server is the canonical interface, same tool shape as the Sentry MCP tools it can stand in for.
- **Rich JSON API alongside** for `/heal`-equivalents, cron, and non-MCP callers — every MCP tool has a parallel `GET /v1/...`.
- **One-fetch issue context.** `errors.get_issue` / `GET /v1/issues/:fp/full-context` returns issue meta + symbolicated latest event + breadcrumbs + similar issues + suspect files + suspect commits + user context in a single call.
- **Bearer-token auth**, two scopes: `READ_TOKEN` (liberal — agents, cron, terminals) and `WRITE_TOKEN` (conservative — mutations only).
- **Dual-send alongside free-tier Sentry**, indefinitely. Sentry is the independent, zero-cost safety net for "who watches the watcher," not a migration target to drop.

## What gets extracted into shared code

Everything in VeHagita's `cloudflare/error-tracker/` that has no VeHagita-specific string baked in becomes a shared package (working name: `maplelens-core`), parameterized instead of hardcoded:

| VeHagita source | Becomes (shared) | Parameterization needed |
|---|---|---|
| `worker.ts` (envelope receive, routing) | Shared worker entrypoint | Custom domain, allowed origins, rate-limit thresholds |
| `fingerprint.ts` | Shared as-is | None — the algorithm is already app-agnostic |
| `d1-schema.sql` / `migrations/*.sql` | Shared schema + migration runner | D1 database name/id only (structure is generic) |
| AE dataset writers (`errors_events`, `errors_breadcrumbs`, `errors_spans`, `errors_replays_meta`) | Shared dataset shape | Dataset names must be unique per CF account — namespaced per app |
| Source-map symbolication (R2 lookup + `source-map` package) | Shared as-is | R2 bucket name |
| `api-routes.ts` (the full JSON API surface) | Shared as-is | Nothing — routes are generic once auth/domain are parameterized |
| `code-context.ts` (suspect files/commits enrichment) | Shared as-is | The release→commits manifest push happens per app's own deploy script, feeding the same shared join logic |
| `mcp-servers/errors/` | Shared MCP server package | `<APP>_ERRORS_API_URL` / `<APP>_ERRORS_TOKEN` env vars instead of `VEHAGITA_*` |
| Frontend SDK fan-out shim (`errorTrackingDiyTransport.ts`) | Shared transport-override pattern | Per-app: which Sentry SDK the app uses (React/Remix vs. whatever EasyCaller's frontend runs), and the app's own DIY endpoint |

## What stays per-instance config

Not extracted — lives in each app's own deploy config / secrets, read the same way VeHagita's runbook already does it:

- Custom domain (`errors-api.<app>.<domain>`, one per app).
- D1 database ID, R2 bucket names, AE dataset names — namespaced so two apps' instances never collide even under one CF account.
- `READ_TOKEN` / `WRITE_TOKEN` — generated per instance, retrieved via the credential-manager skill at deploy/config time, never written to a file or echoed in chat (per the standard's secrets-handling rule, unchanged from both source projects).
- Telegram bot token + chat ID — reuse an existing bot with per-app chat routing, or a distinct bot per app; either way it's config, not code.
- Allowed origins — the app's own frontend domain(s).
- Source-map upload wiring — hooked into whatever build tool the app uses (Vite/Remix for VeHagita; EasyCaller's equivalent, TBD at its deploy step).
- Sentry fallback project ref — the app's own free-tier Sentry project for dual-send.
- All of the above surface through `maple.config.json`'s `errorTracker` block (see [[standard-architecture]]) — `provider`, `endpoint`, `readTokenRef`, `writeTokenRef`, `sentryProject`.

## Deployment story per app

VeHagita's `deployment.md` runbook (provision D1/R2 → wire IDs into `wrangler.toml` → set secrets → apply migrations → deploy → smoke test → register the MCP server → wire admin UI if present → upload source maps → start the soak) generalizes directly into a stack-agnostic runbook template, parameterized the same way as the code:

1. Provision CF resources (D1, R2 buckets) — namespaced per app.
2. Wire the generated D1 `database_id` into that app's Worker config (not a secret — safe to commit).
3. Set Worker secrets (`READ_TOKEN`, `WRITE_TOKEN`, Telegram creds, CF Analytics token) via the credential-manager skill — Maayan runs the `wrangler secret put` prompts himself, reports success only.
4. Apply D1 migrations.
5. Deploy; verify the custom domain resolves to the right Worker (VeHagita's runbook flags this as the one genuinely fiddly step — env-suffixed worker names can silently split from the intended custom domain).
6. Smoke test: unauthed health check, authed read, a thrown test error visible in `/v1/issues` within ~5s (and still landing in Sentry — dual-send confirmed).
7. Register the MCP server in the relevant `~/.claude/settings.json` / project MCP config.
8. Wire source-map upload into that app's post-build step.
9. Start the soak (parity check vs. Sentry) as a confidence exercise — not a drop-gate, per VeHagita's own Phase 10 rescoping. Sentry never goes away.

VeHagita's own execution of this runbook happens in a separate session and is out of scope here — see [[rollout]] for where it sits in the ordered plan. EasyCaller's deploy follows the same template once `maplelens-core` extraction (above) has actually happened — extraction is a prerequisite, not parallelizable with VeHagita's deploy.

## How `/sweep-errors` consumes MapleLens

`maple.config.json` `errorTracker.provider` selects `"maplelens"` once an app's instance is live, `"sentry"` until then — `/sweep-errors` reads this, not a hardcoded assumption.

MCP tools it calls, same inventory as VeHagita's target design:

| Tool | Used for |
|---|---|
| `errors.list_issues` | Pull unresolved issues to cluster (the loop's first step). |
| `errors.get_issue` | One-fetch full context per actionable cluster — stack, breadcrumbs, suspect files/commits, similar issues. |
| `errors.diff_since` | Bound each cycle to what's new since the loop's last run, not a full re-scan. |
| `errors.search_code_path` | Pre-edit check — is the file about to be touched already implicated in an open issue. |
| `errors.resolve` / `errors.ignore` | Final step after a fix's regression test passes the gate — `WRITE_TOKEN`-gated, same permission-note discipline as VeHagita's `/heal` (external write, request approval if not pre-approved). |

Until an app's MapleLens instance is deployed, the same loop logic runs against that app's Sentry MCP tools instead (`search_issues` / `get_sentry_resource`) — the clustering and verification-ladder logic in `/sweep-errors` is written against the tool *contract*, not against MapleLens specifically, so the provider swap is a config change, not a rewrite.
