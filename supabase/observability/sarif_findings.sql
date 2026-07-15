-- SARIF findings ingest table — a Supabase-native data path for security
-- scanner output (an alternative to GHAS-gated GitHub Code Scanning for
-- private repos, and a dashboard data source either way).
--
-- Each scanner workflow (CodeQL, Snyk OSS, Snyk Code, gitleaks, ZAP) POSTs
-- its SARIF output to the `ingest-sarif` Edge Function, which normalizes
-- the results into rows here.
--
-- Delta tracking is native: `first_seen_at`/`last_seen_at`/`state`/`resolved_at`
-- columns let SQL answer "what's new since last run", "what came back",
-- "trended findings over time", etc., without re-parsing SARIF blobs.

CREATE TABLE public.sarif_findings (
  id bigserial PRIMARY KEY,

  -- Scanner identification.
  scanner text NOT NULL,                   -- 'codeql' | 'snyk-oss' | 'snyk-code' | 'gitleaks' | 'zap'
  branch text NOT NULL,                    -- branch the scan ran against
  commit_sha text NOT NULL,                -- HEAD commit at scan time
  run_id bigint NOT NULL,                  -- CI run ID (for traceability)

  -- Finding details (normalized from SARIF).
  rule_id text NOT NULL,                   -- e.g. 'js/path-injection'
  rule_name text,                          -- human-readable rule name
  severity text,                           -- 'critical' | 'high' | 'medium' | 'low' | SARIF level fallback
  message text,                            -- the SARIF result.message.text
  path text,                               -- file path (relative to repo root)
  start_line int,                          -- 1-indexed line number

  -- Dedup fingerprint: sha256 of {scanner, rule_id, path, start_line, branch}.
  -- Lets us detect "same finding seen across multiple runs" without re-keying
  -- on volatile run_id. Branch is part of the key so a finding fixed on one
  -- branch but still present on another stays open there.
  fingerprint text NOT NULL,

  -- Lifecycle.
  state text NOT NULL DEFAULT 'open',      -- 'open' | 'resolved'
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,

  -- Original SARIF result for drill-down (level, locations[], related, etc.).
  raw jsonb,

  -- Same finding (per branch) only stored once. Re-ingest = upsert.
  UNIQUE (scanner, branch, fingerprint)
);

COMMENT ON TABLE public.sarif_findings IS
  'SARIF findings from CodeQL/Snyk/gitleaks/ZAP. Populated by the ingest-sarif Edge Function from CI; queried by your admin/dashboard surface (service-role).';

-- Common dashboard query: "open findings on this branch, sorted by severity".
CREATE INDEX sarif_findings_branch_state_idx
  ON public.sarif_findings (branch, state);

-- Trend / time-series queries.
CREATE INDEX sarif_findings_first_seen_idx
  ON public.sarif_findings (first_seen_at DESC);

-- Per-scanner counts on a dashboard header.
CREATE INDEX sarif_findings_scanner_state_idx
  ON public.sarif_findings (scanner, state);

ALTER TABLE public.sarif_findings ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies ("intentional RLS policy absence"): writes via
-- service-role key (ingest-sarif Edge Function), reads via your own
-- service-role admin surface. No anon/authenticated access ever.
