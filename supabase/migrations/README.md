# Migrations

Empty on a fresh clone — this directory is the **single source of truth for
the database schema**. Never edit the schema through the Supabase dashboard;
the drift sentinel (`.github/workflows/drift-sentinel.yml`) will catch you.

## Naming convention (pre-commit-enforced)

```
YYYYMMDDHHMMSS_short_description.sql
```

- 14-digit UTC timestamp prefix (`date -u +%Y%m%d%H%M%S`)
- lowercase snake_case description
- `.husky/pre-commit` rejects anything else

## Workflow

1. `supabase migration new short_description` (or hand-create the file)
2. Write the SQL — build it right the first time: indexes, RLS policies,
   constraints sized for real growth, comments on every table.
3. `pnpm supabase:reset` — applies all migrations to the local stack
4. `pnpm supabase:types` — regenerate `src/types/database.types.ts` (the
   freshness gate fails the build if you forget)
5. Add/extend an RLS test in `supabase/tests/`
6. Commit migration + types + tests together

## Optional starter migrations

`supabase/observability/` contains ready-to-apply migrations for the CI
observability tables (`sarif_findings`, `build_warnings`, `rls_violations`).
Copy them here with fresh timestamps when you want the full security
dashboard pipeline — see `supabase/observability/README.md`.
