// ─────────────────────────────────────────────────────────────────────────
// ingest-build-warnings: receives ESLint / TSC error+warning counts from
// the quality.yml GitHub Actions workflow and persists them via the
// `log_build_warnings` RPC so a dashboard can show whether build warnings
// are trending up or down over time.
//
// Apply supabase/observability/build_warnings.sql first (see its README).
//
// Same shape as ingest-sarif: bearer-token auth (CI-to-server shared
// secret), constant-time token compare, no JWT, service-role insert.
//
// Auth: Bearer BUILD_WARNINGS_INGEST_TOKEN. Token is set as a Supabase
// Edge Function secret AND a GitHub Actions repo secret.
//
// Deploy: supabase functions deploy ingest-build-warnings --no-verify-jwt
//   (--no-verify-jwt because we do our own bearer-token check; the built-in
//   JWT verifier would reject the GitHub Actions caller.)
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from 'supabase-js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INGEST_TOKEN = Deno.env.get('BUILD_WARNINGS_INGEST_TOKEN') ?? '';

const ALLOWED_KINDS = new Set(['eslint', 'tsc']);

interface ResultEntry {
  kind: string;
  error_count: number;
  warning_count: number;
}

interface IngestBody {
  run_id: string | number;
  branch: string;
  commit_sha: string;
  results: ResultEntry[];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Constant-time string compare (see ingest-sarif for rationale).
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function isFiniteNonNegativeInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405);
  }
  if (!INGEST_TOKEN) {
    return jsonResponse({ error: 'ingest_token_not_configured' }, 503);
  }

  // Bearer auth.
  const authHeader = req.headers.get('Authorization') ?? '';
  const presented = authHeader.replace(/^Bearer\s+/i, '');
  if (!presented || !safeEqual(presented, INGEST_TOKEN)) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  let body: IngestBody;
  try {
    body = await req.json() as IngestBody;
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  // Validation.
  const runIdStr = typeof body.run_id === 'number' ? String(body.run_id) : body.run_id;
  if (!runIdStr || typeof runIdStr !== 'string' || runIdStr.length === 0 || runIdStr.length > 64) {
    return jsonResponse({ error: 'invalid_run_id' }, 400);
  }
  if (!body.branch || typeof body.branch !== 'string' || body.branch.length === 0 || body.branch.length > 128) {
    return jsonResponse({ error: 'invalid_branch' }, 400);
  }
  if (!body.commit_sha || typeof body.commit_sha !== 'string' || !/^[0-9a-f]{7,40}$/i.test(body.commit_sha)) {
    return jsonResponse({ error: 'invalid_commit_sha' }, 400);
  }
  if (!Array.isArray(body.results) || body.results.length === 0) {
    return jsonResponse({ error: 'results_required' }, 400);
  }
  if (body.results.length > 10) {
    return jsonResponse({ error: 'too_many_results' }, 400);
  }

  for (const r of body.results) {
    if (!r || typeof r !== 'object') {
      return jsonResponse({ error: 'invalid_result_entry' }, 400);
    }
    if (!ALLOWED_KINDS.has(r.kind)) {
      return jsonResponse({ error: 'unknown_kind', allowed: [...ALLOWED_KINDS] }, 400);
    }
    if (!isFiniteNonNegativeInt(r.error_count) || !isFiniteNonNegativeInt(r.warning_count)) {
      return jsonResponse({ error: 'invalid_counts' }, 400);
    }
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    let inserted = 0;
    for (const r of body.results) {
      const { error } = await supabase.rpc('log_build_warnings', {
        p_run_id: runIdStr,
        p_branch: body.branch,
        p_commit_sha: body.commit_sha,
        p_kind: r.kind,
        p_error_count: r.error_count,
        p_warning_count: r.warning_count,
      });
      if (error) {
        console.error('[ingest-build-warnings] insert failed:', error.message);
        return jsonResponse({
          error: 'insert_failed',
          detail: error.message,
          inserted,
          kind: r.kind,
        }, 500);
      }
      inserted += 1;
    }

    return jsonResponse({ ok: true, inserted }, 200);
  } catch (err) {
    console.error('[ingest-build-warnings] unhandled error:', err);
    return jsonResponse({ error: 'internal_error', message: String(err) }, 500);
  }
});
