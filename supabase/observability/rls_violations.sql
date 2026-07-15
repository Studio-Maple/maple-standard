-- RLS violation telemetry.
--
-- Captures every Postgres "insufficient_privilege" (sql_state 42501) the
-- app encounters, regardless of who called the failing query. The signal
-- value:
--
--   1. App bugs: a query that should pass RLS hitting 42501 means your app
--      logic disagrees with the policy. Surfaces gaps in the integration
--      tests before users see them.
--   2. Probe activity: a burst of 42501s from one IP suggests someone with
--      the public anon key is hand-crafting queries to enumerate the data
--      surface — tells you when you're actively being probed.
--
-- Wire the write side into your error tracking: when a Supabase error has
-- code 42501, call the `log_rls_violation` RPC (fire-and-forget beacon).
--
-- NOTE the read policy below assumes a `public.users` table with an
-- `is_admin boolean` column — ADAPT IT to your own admin model before
-- applying this migration (or drop the policy and read via service-role
-- only, like sarif_findings).

CREATE TABLE IF NOT EXISTS public.rls_violations (
  id              BIGSERIAL PRIMARY KEY,
  source          TEXT NOT NULL CHECK (source IN ('frontend', 'logs-poller')),
  ip              TEXT,                          -- forwarded client IP, may be null
  user_id         UUID,                          -- auth.uid() at error time, null if anon
  path            TEXT CHECK (length(path) <= 512),
  table_name      TEXT CHECK (length(table_name) <= 64),
  operation       TEXT CHECK (operation IN ('select', 'insert', 'update', 'delete', 'rpc', NULL) OR operation IS NULL),
  error_message   TEXT CHECK (length(error_message) <= 1024),
  ua_hash         TEXT CHECK (length(ua_hash) <= 16),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rls_violations_created_at_idx
  ON public.rls_violations(created_at DESC);
CREATE INDEX IF NOT EXISTS rls_violations_ip_created_idx
  ON public.rls_violations(ip, created_at DESC);

ALTER TABLE public.rls_violations ENABLE ROW LEVEL SECURITY;

-- ADAPT: admin-only read — assumes public.users(is_admin). Replace with your
-- own admin predicate, or delete the policy to keep reads service-role-only.
DROP POLICY IF EXISTS "rls_violations: admin select" ON public.rls_violations;
CREATE POLICY "rls_violations: admin select"
  ON public.rls_violations
  FOR SELECT
  USING (auth.uid() IN (SELECT id FROM public.users WHERE is_admin = true));

-- ---------------------------------------------------------------
-- log_rls_violation RPC — the single write path for the table.
-- SECURITY DEFINER so anon can log without read access. All inputs
-- validated; no user-controlled SQL ever evaluated.
-- ---------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_rls_violation(
  p_source        TEXT,
  p_path          TEXT DEFAULT NULL,
  p_table_name    TEXT DEFAULT NULL,
  p_operation     TEXT DEFAULT NULL,
  p_error_message TEXT DEFAULT NULL,
  p_ua_hash       TEXT DEFAULT NULL,
  p_ip            TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_source NOT IN ('frontend', 'logs-poller') THEN
    RAISE EXCEPTION 'invalid source: %', p_source USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.rls_violations(
    source, ip, user_id, path, table_name, operation, error_message, ua_hash
  ) VALUES (
    p_source,
    left(p_ip, 64),
    auth.uid(),                               -- captured server-side from JWT; do not trust client
    left(p_path, 512),
    left(p_table_name, 64),
    p_operation,
    left(p_error_message, 1024),
    left(p_ua_hash, 16)
  );
END;
$$;

-- Anon + authenticated can call to log their own 42501 events.
GRANT EXECUTE ON FUNCTION public.log_rls_violation(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO anon, authenticated;

-- ---------------------------------------------------------------
-- 7-day purge — telemetry is only useful while recent.
-- ---------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'purge-rls-violations') THEN
    PERFORM cron.unschedule('purge-rls-violations');
  END IF;
END
$$;

SELECT cron.schedule(
  'purge-rls-violations',
  '0 4 * * *',
  $$DELETE FROM public.rls_violations WHERE created_at < now() - INTERVAL '7 days'$$
);
