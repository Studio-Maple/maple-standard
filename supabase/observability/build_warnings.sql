-- Build warnings persistence — track ESLint / TypeScript warning + error
-- counts over time so a dashboard can show whether the codebase is
-- accumulating debt between runs.
--
-- Populated by the `ingest-build-warnings` Edge Function (called from the
-- quality.yml GitHub Actions workflow).
--
-- Same write/read posture as `sarif_findings`: service-role only, no RLS
-- policies ("intentional RLS policy absence").

CREATE TABLE public.build_warnings (
  id bigserial PRIMARY KEY,

  -- CI run ID for traceability. NOT unique — a single workflow run produces
  -- one row per `kind` (eslint, tsc), so the same run_id will appear
  -- multiple times.
  run_id text NOT NULL,

  branch text NOT NULL,
  commit_sha text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('eslint', 'tsc')),

  error_count integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.build_warnings IS
  'ESLint/TSC error+warning counts captured per CI run. Populated by ingest-build-warnings; read by your admin/dashboard surface (service-role).';

-- Dashboard trend query: "give me the last 7 days for a branch, by kind".
CREATE INDEX build_warnings_branch_created_at_idx
  ON public.build_warnings (branch, created_at DESC);

-- Per-kind queries: "most recent eslint row regardless of branch".
CREATE INDEX build_warnings_kind_created_at_idx
  ON public.build_warnings (kind, created_at DESC);

ALTER TABLE public.build_warnings ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies. Writes via service-role key from the
-- ingest-build-warnings Edge Function; reads via your own service-role
-- admin surface. Same posture as `sarif_findings`.

-- ─────────────────────────────────────────────────────────────────────────
-- SECURITY DEFINER RPC for the Edge Function.
--
-- The Edge Function does have the service-role key and could INSERT
-- directly, but going through a validating RPC gives us:
--   - input validation (kind whitelist, non-negative counts, length caps)
--   - one place to evolve the schema (e.g. add per-rule counts later)
--   - a consistent shape for every ingest path
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.log_build_warnings(
  p_run_id text,
  p_branch text,
  p_commit_sha text,
  p_kind text,
  p_error_count integer,
  p_warning_count integer
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_run_id IS NULL OR length(p_run_id) = 0 OR length(p_run_id) > 64 THEN
    RAISE EXCEPTION 'invalid run_id length'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_branch IS NULL OR length(p_branch) = 0 OR length(p_branch) > 128 THEN
    RAISE EXCEPTION 'invalid branch length'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_commit_sha IS NULL OR p_commit_sha !~ '^[0-9a-f]{7,40}$' THEN
    RAISE EXCEPTION 'invalid commit_sha'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('eslint', 'tsc') THEN
    RAISE EXCEPTION 'invalid kind: %', p_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_error_count IS NULL OR p_error_count < 0 OR p_error_count > 100000 THEN
    RAISE EXCEPTION 'invalid error_count: %', p_error_count
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_warning_count IS NULL OR p_warning_count < 0 OR p_warning_count > 100000 THEN
    RAISE EXCEPTION 'invalid warning_count: %', p_warning_count
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.build_warnings(
    run_id, branch, commit_sha, kind, error_count, warning_count
  )
  VALUES (
    p_run_id, p_branch, p_commit_sha, p_kind, p_error_count, p_warning_count
  );
END;
$$;

-- Revoke from PUBLIC (which includes anon + authenticated) and grant only
-- to service_role. The Edge Function uses the service-role client.
REVOKE EXECUTE ON FUNCTION public.log_build_warnings(text, text, text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_build_warnings(text, text, text, text, integer, integer) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- pg_cron retention purge: keep 60 days of history — enough to show trend
-- over multiple sprints without letting the table grow unbounded on a busy
-- CI cadence.
-- ─────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-build-warnings') THEN
    PERFORM cron.unschedule('purge-build-warnings');
  END IF;
END
$$;

SELECT cron.schedule(
  'purge-build-warnings',
  '0 4 * * *',
  $$DELETE FROM public.build_warnings WHERE created_at < now() - INTERVAL '60 days'$$
);
