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

## Role grants are a separate gate — every schema needs a grants migration

Current Supabase postgres images ship **hardened default privileges**:
tables created in migrations (i.e. by `postgres`) give the API roles
(`anon` / `authenticated` / `service_role`) **no DML at all**, while new
functions keep PostgreSQL's default `EXECUTE` for `PUBLIC` — so `anon` can
call any helper via RPC. RLS policies alone never fire: the query dies
earlier with `42501 permission denied for table`. Grants and policies are
two separate gates, and the grants gate must be granted explicitly.

Ship a `role_grants` migration with (or right after) your initial schema,
and extend it as tables are added. Proven posture from the first
production instantiation of this template:

```sql
-- service_role: full DML, now and for future tables (server-side only).
grant all on all tables in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;

-- anon: NOTHING — hard-deny by omission (unless you truly serve anonymous users).

-- authenticated: verbs mirroring the RLS policies, table by table.
grant select on all tables in schema public to authenticated;
grant insert, update, delete on public.your_writable_table to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Functions: revoke the PUBLIC default, grant back exactly who calls them.
revoke execute on function public.is_admin(uuid) from public;
grant execute on function public.is_admin(uuid) to authenticated;
-- Trigger/cron internals: revoke from public, grant back nobody.
revoke execute on function public.set_updated_at() from public;
```

Verify live from `supabase/tests/` (anon RPC on a helper must return
`42501`, not a result) — the SQL Editor bypasses grants and proves nothing.

## Optional starter migrations

`supabase/observability/` contains ready-to-apply migrations for the CI
observability tables (`sarif_findings`, `build_warnings`, `rls_violations`).
Copy them here with fresh timestamps when you want the full security
dashboard pipeline — see `supabase/observability/README.md`.
