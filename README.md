# maple-standard

A ready-to-clone **Next.js (App Router, TypeScript) + Supabase + Vercel**
project skeleton with a proven quality / observability / security framework
baked in from commit one. Distilled by Studio Maple from a production
codebase where every rule below earned its place.

**The philosophy: enforce by mechanism, not by trust.** Discipline and
AI-agent context drift; a CI check, a git hook, or a compile error doesn't.
Everything this template promises is backed by a gate that fails red — not
a convention someone has to remember.

## What you get

- **Minimal but complete Next.js app** — App Router, strict TypeScript,
  layered `src/` (`app → components → ui → hooks → services → lib`), typed
  Supabase clients (browser/server/middleware), Sentry wired for
  client/server/edge, one health route, one component — nothing to delete
  except the placeholder page.
- **Tiered local CI** (`scripts/ci-local.sh` + a native PowerShell mirror):
  `fast` (lint → typecheck → dead-code → architecture → tests → build →
  docs-drift) · `gate` (fast + RLS + smoke E2E, run by pre-push — *you
  cannot push red*) · `core` · `full`.
- **Full cloud CI** (`.github/workflows/`): a requirable quality gate,
  Supabase migration validation + generated-types freshness, CodeQL, Snyk,
  gitleaks, weekly ZAP DAST, a prod-schema drift sentinel, Dependabot with
  safe-class automerge. Vercel's git integration handles deploys — no
  deploy workflows to maintain.
- **Escape-proof Supabase typing**: a custom ESLint rule forces
  `<Database>` on every client factory; type-checked `no-unsafe-*` rules on
  the data layer; a freshness gate that fails when `database.types.ts`
  drifts from the migrations.
- **A docs system agents can't rot**: `docs/` wiki (Obsidian-compatible)
  with a machine-readable index, a structural drift gate, BM25 doc search,
  collision-free ID allocation for decisions/tasks, and Claude Code hooks
  that nudge decision-logging and doc-syncing at session end.
- **Secrets hygiene by default**: reads of credential files are hook-blocked,
  tool output is secret-scrubbed, gitleaks runs on every PR, `.env.example`
  is the only env file that's ever committed.

## Already have a project? Use the plugin, skip the clone

Everything above is for starting a **new** project from this template. If
you have an **existing** project and just want the stack-agnostic parts —
parallel-session worktrees, the safety/hygiene hooks, the docs-drift
executor, self-healing error triage, and the budget-bounded loop pack —
this repo also ships a Claude Code **plugin** (`plugin/`) that installs
into any project via the marketplace, no cloning required:

```
/plugin marketplace add C:\Projects\Maple-Standard
/plugin install maple-standard@maple-standard
/adopt-standard   # from inside the target project — stamps config + docs
```

Full schema, install details, and the layer map (plugin vs. this template
vs. what gets generated per-project) live in [`plugin/README.md`](plugin/README.md).

## Quick start (evaluate the template itself)

```sh
pnpm install
pnpm ci:fast        # the full fast tier — should be green out of the box
pnpm dev            # http://localhost:3000
```

## Instantiate a new project

1. **Clone without history**
   ```sh
   pnpm dlx degit your-org/maple-standard my-project   # or git clone + rm -rf .git
   cd my-project && git init && pnpm install
   ```
2. **Rename** — search-and-replace the placeholders:
   - `maple-standard` → your repo name (`package.json`, `README`, hook temp-file
     prefixes in `.claude/hooks/*.js`, `e2e/smoke.spec.ts`, `src/app/page.tsx`)
   - `your-project` → your product name (`CLAUDE.md`, `supabase/config.toml`
     `project_id`, `.env.example`, `zap.yml` staging URL)
   - Rewrite the intro paragraph + Stack table in `CLAUDE.md`.
3. **Supabase project**
   - Create a project at supabase.com (or your org); note the project ref.
   - `supabase link --project-ref <ref>`
   - Local dev: `pnpm supabase:start && pnpm supabase:reset`
   - First migration → `pnpm supabase:types` → commit both.
   - Optional: apply `supabase/observability/*.sql` + deploy the two ingest
     edge functions (see `supabase/observability/README.md`).
4. **Vercel project**
   - Import the GitHub repo in Vercel (framework auto-detected).
   - Set env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     and (for Sentry) `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`,
     `SENTRY_AUTH_TOKEN`.
5. **Sentry**
   - Create a Next.js project in Sentry; copy the DSN into Vercel env +
     `.env.local`. Source maps upload automatically once
     `SENTRY_ORG`/`SENTRY_PROJECT`/`SENTRY_AUTH_TOKEN` exist at build time
     (the config no-ops without them).
6. **GitHub settings + secrets**
   - Branch protection on your default branch; require the
     "Lint, Typecheck, Dead-code, Arch & Test" check (quality.yml runs
     unfiltered precisely so it can be required). Enable "Allow auto-merge".
   - Secrets (all optional — every workflow skips gracefully without them):

     | Secret | Enables |
     |---|---|
     | `SNYK_TOKEN` | snyk.yml (SAST + SCA) |
     | `SUPABASE_PROJECT_REF` / `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_PASSWORD` | drift-sentinel.yml |
     | `SARIF_INGEST_TOKEN` / `SARIF_INGEST_URL` | scanner-findings ingest to your Supabase dashboard tables |
     | `BUILD_WARNINGS_INGEST_TOKEN` / `BUILD_WARNINGS_INGEST_URL` | eslint/tsc trend ingest |
7. **Local env**: `cp .env.example .env.local`, fill in. Never commit it;
   agents are hook-blocked from reading it.
8. **Sanity check**: `pnpm ci:fast` green → first commit → push (pre-push
   runs the gate; use `SKIP_LIVE_GATE=1` until Docker/Supabase local is set
   up) → check `docs/tasks.md` `#T1` off the list.

## What's enforced, and by what

### Local gates

| Gate | What it enforces | Where it runs |
|---|---|---|
| `eslint --max-warnings=0` | zero warnings; `no-explicit-any`; ban-ts-comment (only described `@ts-expect-error`); curated `eslint-plugin-security` rules; import order; per-layer `max-lines` (hook 250 / component 300 / service·lib 350 / app 500); `<Database>` generic on every Supabase client (custom rule); type-checked `no-unsafe-*` on the data layer | fast tier, pre-commit (staged scope), quality.yml |
| `tsc --noEmit` | strict + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch` | fast tier, pre-commit, quality.yml |
| knip | no dead files/deps (error); unused exports surfaced (warn) | fast tier, quality.yml |
| dependency-cruiser | layering: services/lib React-free; lib ↛ services; ui ↛ services; prod ↛ tests; no undeclared deps; cycles warned | fast tier, quality.yml |
| vitest | unit + component tests (jsdom + testing-library + MSW) | fast tier, quality.yml |
| `next build` | the app actually builds | fast tier, quality.yml |
| docs-drift (`check-docs-drift.mjs`) | no dead `Code:` paths, no broken wikilinks, fresh `.docs-index.json`, no ID collisions, entry length caps | fast tier, quality.yml |
| types-freshness (`check-types-fresh.mjs`) | `database.types.ts` matches the migration schema | gate tier, supabase-migrations.yml |
| RLS suite (`supabase/tests/`) | policies tested from the real anon client context against live local Supabase | gate tier |
| Playwright `@smoke` | the app boots and core flows respond | gate tier |
| migration naming | `YYYYMMDDHHMMSS_description.sql` | pre-commit |
| pre-push = gate tier | you cannot push red (`SKIP_LIVE_GATE=1` for no-Docker boxes — never `--no-verify`) | husky |

### Cloud CI

| Workflow | What it enforces | Cadence |
|---|---|---|
| quality.yml | the whole fast tier, as a requirable PR check + daily baseline | push/PR/daily |
| supabase-migrations.yml | migrations apply cleanly to a fresh DB; `db lint`; types freshness | supabase changes |
| codeql.yml | SAST, security-extended query pack | push/PR/weekly |
| snyk.yml | Snyk Code (SAST) + OSS (SCA), quota-aware daily; skips without token | daily |
| gitleaks.yml | committed-secret scan — diff on PR, full history weekly | PR/push/weekly |
| zap.yml | passive DAST baseline against staging (headers, cookies, misconfig) | weekly |
| drift-sentinel.yml | prod schema == checked-in migrations (`db diff --linked`); opens/auto-closes a tracking issue | weekly + migration pushes |
| dependabot-automerge.yml | dep bumps validated with a read-only token; dev/patch classes automerged, runtime-minor/major escalated | Dependabot PRs |

### Claude Code hooks (`.claude/`)

| Hook | Event | What it does |
|---|---|---|
| eslint-fix | PostToolUse (Edit/Write) | auto-`eslint --fix` the edited file |
| size-warning | PostToolUse (Edit/Write) | immediate per-layer line-cap warning |
| build-counter | PostToolUse (Edit/Write) | `tsc --noEmit` every 5th edit — type errors surface fast |
| scrub-secrets | PostToolUse (Bash/Read/Grep) | redacts secret-shaped strings from tool output before they reach model context |
| deny-credential-paths | PreToolUse (Read) | blocks reads of `.env*`, ssh keys, npmrc, cloud creds |
| ask-gate | PreToolUse (AskUserQuestion) | blocks questions the docs already answer (BM25 retrieval + optional headless-model judge; fail-open, max 2 nudges) |
| dirty-tree-guard | Stop | lists uncommitted code changes at session end |
| docs-sync-reminder | Stop | names docs whose owned code changed but weren't touched |
| decision-reminder | Stop | nudges to log a `D###` when the turn contains decision language |
| parallel-session-warn | SessionStart | warns when other git worktrees are active on a shared checkout |

## Repo map

```
.claude/            agent hooks + settings (the always-on enforcement layer)
.claude-plugin/      marketplace manifest (makes this repo a plugin marketplace)
.github/            cloud CI workflows + dependabot
.husky/             pre-commit (staged lint+tsc, migration naming) · pre-push (gate tier)
docs/               project knowledge base — index, decisions, tasks, gaps, log, quality
e2e/                Playwright config + @smoke specs (local-first)
eslint-rules/       require-database-generic (custom rule)
plugin/             the maple-standard Claude Code plugin — see plugin/README.md
scripts/            tiered CI (sh+ps1) · docs tooling (drift gate, index, BM25 search, ID allocator) · types-freshness
src/                app/ components/ ui/ hooks/ services/ lib/ test/ types/ (+ Sentry configs)
supabase/           config · migrations (empty, convention-documented) · observability starters · ingest edge functions · live RLS tests
```

## License

MIT © Studio Maple
