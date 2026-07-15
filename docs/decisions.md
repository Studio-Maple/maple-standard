# Decisions

> **Audience:** agents + owner. Read before asking; cite before asserting.
> **Authoritative for:** every settled call. Newest first.
> **Updated by:** `node scripts/next-task-id.mjs --add --decision --title "..." --body "..."`

Each entry: `## D### | YYYY-MM-DD | title` + 1-2 sentences (≤600 chars,
gate-enforced). The call and its pointers only — detail lives in the
affected doc/code/CHANGELOG.

## D001 | 2026-07-15 | Template baseline
This project is instantiated from maple-standard: Next.js (App Router) +
TypeScript + Supabase + Vercel, quality framework enforced by mechanism
(hooks, tiered gates, CI). Framework changes are decisions — log them here.
