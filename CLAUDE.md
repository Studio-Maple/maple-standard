# your-project

@AGENTS.md

<!-- Replace the paragraph below when instantiating: one sentence on what
     the product is, one on the scale it's judged at. The charter that
     follows is the maple-standard baseline — adapt thresholds, keep the
     mechanisms. -->
A Next.js (App Router, TypeScript) + Supabase + Vercel application built on
the maple-standard framework. **Every decision is judged at production
scale** — this is the prime directive, not a footnote.

## Long-run over patches

**The methodology: enforce by mechanism, not by trust.** Context-engineering
and good discipline drift; a CI check, a hook, or a compile error doesn't.
Every rule here is (or becomes) one — that's why there's no bypass.

1. **Build it right, the first time.** Every schema / RLS policy / query /
   dependency is built for real growth — the complete long-run solution, not
   an MVP to patch later; if it needs more orchestration to do right,
   orchestrate (effort is never the constraint, correctness is). Track
   genuinely deferred scope with a `#T` **honestly** — a `#T` is for real
   future work, *not* a band-aid over rot you could fix now. Aim for a
   falling debt line, not a quota.
2. **No bypass.** No `--no-verify`, no `service_role` on the client, no
   `any`, no blanket `eslint-disable`, no untyped `create*Client` (the
   `<Database>` generic is ESLint-enforced; `database.types.ts` is
   freshness-gated). Oversize files get decomposed when touched, not
   extended. Schema changes are migrations, never dashboard edits (the
   drift sentinel catches those). The gate is the enforcement.
3. **Real boundaries in tests.** RLS / auth / edge functions test against
   live local Supabase (`supabase/tests/`); mocks only at unit edges (MSW
   in `src/test/`).
4. **Ground, don't hallucinate.** Decisions, tasks, and aims are written
   down (`docs/decisions.md`, `docs/tasks.md`) and retrieved *before* you
   ask or assert (`node scripts/doc-search/search.mjs "..."` or grep).
   Never re-litigate a settled call or state system-state from memory —
   check first, cite the source.
5. **One branch, always clean.** Commit every short, working batch
   proactively — a dirty tree blocks parallel sessions and loses work.
6. **Docs stay synced by mechanism.** The drift gate
   (`scripts/check-docs-drift.mjs`, fast tier) blocks dead `Code:` paths /
   broken wikilinks / stale index; the `docs-sync-reminder` Stop hook flags
   semantic drift (code changed under a doc's ownership, doc untouched).

## Stack

<!-- Fill in per project. Versions live in package.json, not here — track
     latest, bump deliberately + tested, never pin out of inertia. -->

| Layer | What |
|---|---|
| **Frontend** | Next.js App Router + React + TypeScript (strict) |
| **Backend** | Supabase (Postgres + RLS · Deno Edge Functions · Auth · Storage) |
| **Deploy** | Vercel (git integration — no deploy workflows in this repo) |
| **Observability** | Sentry (`@sentry/nextjs`) + optional Supabase observability tables |
| **Enforcement** | tiered local gates + husky + Claude Code hooks + full cloud CI — see `docs/quality.md` |

Layering (dependency-cruiser-enforced): `app → components → ui → hooks →
services → lib`; services/lib are React-free; production never imports
tests.

## Workflow

**Trivial** (bug fix, UI tweak, single-file edit): just do it — build
passes, commit, show the user.

**Substantive** (multi-step — feature, migration, CI, infra, refactor):
discuss scope → implement, committing working batches (rule 5) → run the
gate → present for sign-off — **"done" needs explicit approval**. If
project state changed, propose updates to the relevant `docs/` page(s).

**Always:** never self-declare "done"; 1 retry on failure, then escalate;
update `CHANGELOG.md` after significant changes.

## Decision integrity

The worst failure is a decision made *in chat* that never lands —
re-litigated, contradicted, or lost. Three defenses, all hook-backed:

1. **Document a decision the moment it's made.** Append a short `D###` to
   `docs/decisions.md` — the call in 1-2 sentences + pointers, ≤600 chars —
   then thread it into the affected doc/`#T`. *(The `decision-reminder`
   Stop hook nudges if you don't.)*
2. **Check before asking.** Search `docs/decisions.md` + `docs/gaps.md` +
   `docs/tasks.md` first — if the answer's there, act on it and cite it,
   don't ask. The `ask-gate` hook enforces this on `AskUserQuestion`.
3. **IDs are allocated, not guessed.** `node scripts/next-task-id.mjs
   [--decision|--session]` prints the next id; `--add` allocates AND
   inserts atomically (lockfile mutex — parallel sessions can't collide)
   and refuses entries that would break the drift gate.

## Code quality

Size limits are **ESLint-enforced per layer** (hook 250 · component 300 ·
service/util 350 · app route/page 500) — the build fails over the cap;
**decompose, never raise it**. `ui/` primitives and tests are exempt.

## Testing

Vitest unit + component tests (`pnpm test`) · Playwright E2E in `e2e/`
(`@smoke` tag = the fast pre-push subset) · live-boundary RLS tests in
`supabase/tests/` (rule 3). Tiers: `pnpm ci:fast` / `ci:gate` / `ci:core` /
`ci:full` (Windows: `ci:*:win`).

## Secrets handling (zero-trust toward agent logs)

Assume every Bash/Read output reaches the model provider's logs — treat
anything an agent can read as semi-public. **Hard rules (hook-enforced):**
never read credential files (`.env*`, `.credentials.json`, `~/.ssh/id_*` —
PreToolUse-blocked); never echo secrets or secret-bearing env vars (outputs
are scrubbed by `scrub-secrets.mjs` — don't rely on it). Prefer server-side
secret stores (Supabase / GitHub / Vercel); local copies live in the OS
credential manager (Windows Credential Manager / macOS Keychain), never in
files the agent reads. **Prod deploys / migrations / key rotation:**
produce the command for the human — they report success only, never
values. `.env.example` documents the shape; `.env.local` is gitignored and
hook-blocked.

## Session start

Read `docs/index.md` → check `docs/gaps.md` for anything the owner flagged
→ check `docs/tasks.md` for open work. Project history in `CHANGELOG.md`.
