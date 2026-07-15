# Observability tables (optional starter migrations)

Ready-to-apply migrations for the CI observability pipeline, adapted from a
production deployment of this pattern. They live here (not in
`supabase/migrations/`) so a fresh clone stays migration-free and the
types-freshness gate stays quiet until you opt in.

## What you get

| Table | Fed by | Gives you |
|---|---|---|
| `sarif_findings` | `ingest-sarif` edge function ← CodeQL/Snyk/gitleaks/ZAP workflows | Normalized SAST/DAST findings with `open/resolved` delta tracking across runs — "what's new since last scan", trends, a security dashboard data source |
| `build_warnings` | `ingest-build-warnings` edge function ← quality.yml | ESLint/TSC error+warning counts per CI run — is the codebase accumulating debt? |
| `rls_violations` | `log_rls_violation` RPC ← your app's error tracking | Every Postgres 42501 (insufficient_privilege) the app hits — app/policy mismatches AND probe-activity detection |

## To enable

1. Copy each `.sql` file into `supabase/migrations/` with a fresh timestamp:
   ```sh
   TS=$(date -u +%Y%m%d%H%M%S)
   cp supabase/observability/sarif_findings.sql "supabase/migrations/${TS}_sarif_findings.sql"
   # repeat (with distinct timestamps) for build_warnings.sql, rls_violations.sql
   ```
2. `pnpm supabase:reset && pnpm supabase:types` — commit both.
3. Deploy the ingest functions (each does its own bearer-token auth):
   ```sh
   supabase functions deploy ingest-sarif --no-verify-jwt
   supabase functions deploy ingest-build-warnings --no-verify-jwt
   ```
4. Generate one strong random token per function, set it BOTH as a Supabase
   function secret and a GitHub Actions repo secret:
   - `SARIF_INGEST_TOKEN` + repo secret `SARIF_INGEST_URL`
     (`https://<ref>.supabase.co/functions/v1/ingest-sarif`)
   - `BUILD_WARNINGS_INGEST_TOKEN` + repo secret `BUILD_WARNINGS_INGEST_URL`
5. The workflows pick them up automatically (they skip while unset).

## Security posture

`sarif_findings` + `build_warnings`: RLS enabled, deliberately NO policies —
writes only via service-role (the edge functions), reads only via your own
service-role admin surface. `rls_violations`: writes via SECURITY DEFINER
RPC (anon can log without reading), reads admin-only — adapt the read policy
to your own admin model before applying.
