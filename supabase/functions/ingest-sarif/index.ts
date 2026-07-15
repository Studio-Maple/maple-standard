// ─────────────────────────────────────────────────────────────────────────
// ingest-sarif: receives SARIF blobs from GitHub Actions security workflows
// and normalizes them into the `sarif_findings` table (delta tracking for
// your security dashboard / audit tooling).
//
// Apply supabase/observability/sarif_findings.sql first (see its README).
//
// Auth: Bearer SARIF_INGEST_TOKEN. Token is set as a Supabase Edge Function
// secret AND a GitHub Actions repo secret. Constant-time comparison prevents
// timing attacks. NOT a JWT — that path is for end-user actions; this is a
// CI-to-server pipe with a single shared secret per repo.
//
// Deploy: supabase functions deploy ingest-sarif --no-verify-jwt
//   (--no-verify-jwt because we do our own bearer-token check; the built-in
//   JWT verifier would reject the GitHub Actions caller.)
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from 'supabase-js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const INGEST_TOKEN = Deno.env.get('SARIF_INGEST_TOKEN') ?? '';

const ALLOWED_SCANNERS = new Set([
  'codeql',
  'snyk-oss',
  'snyk-code',
  'gitleaks',
  'zap',
]);

interface SarifResult {
  ruleId?: string;
  ruleIndex?: number;
  level?: string;
  message?: { text?: string };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: { startLine?: number };
    };
  }>;
  properties?: Record<string, unknown>;
}

interface SarifRule {
  id: string;
  name?: string;
  shortDescription?: { text?: string };
  fullDescription?: { text?: string };
  properties?: {
    'security-severity'?: string;
    security_severity_level?: string;
    tags?: string[];
  };
  defaultConfiguration?: { level?: string };
}

interface SarifRun {
  tool?: { driver?: { name?: string; rules?: SarifRule[] } };
  results?: SarifResult[];
}

interface SarifDocument {
  version?: string;
  runs?: SarifRun[];
}

interface IngestBody {
  scanner: string;
  branch: string;
  commit_sha: string;
  run_id: number | string;
  sarif: SarifDocument;
}

interface NormalizedFinding {
  scanner: string;
  branch: string;
  commit_sha: string;
  run_id: number;
  rule_id: string;
  rule_name: string | null;
  severity: string;
  message: string;
  path: string;
  start_line: number;
  fingerprint: string;
  raw: SarifResult;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Constant-time string compare. crypto.subtle.timingSafeEqual would be ideal
// but Deno's Web Crypto doesn't expose it; this manual loop achieves the
// same property as long as both inputs are the same length.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Maps SARIF level + rule properties into a unified severity vocabulary.
// CodeQL/Snyk Code tag findings with `security-severity` (CVSS-like 0.0-10.0)
// and/or `security_severity_level` (low|medium|high|critical). Tools without
// security tagging fall back to the SARIF `level` (note|warning|error).
function pickSeverity(result: SarifResult, rule: SarifRule | undefined): string {
  const props = rule?.properties ?? {};
  const named = (props.security_severity_level ?? '').toString().toLowerCase();
  if (named) return named;

  const numeric = parseFloat((props['security-severity'] ?? '').toString());
  if (Number.isFinite(numeric)) {
    if (numeric >= 9.0) return 'critical';
    if (numeric >= 7.0) return 'high';
    if (numeric >= 4.0) return 'medium';
    if (numeric > 0) return 'low';
  }

  const level = (result.level ?? rule?.defaultConfiguration?.level ?? '').toLowerCase();
  if (level === 'error') return 'high';
  if (level === 'warning') return 'medium';
  if (level === 'note') return 'low';
  return 'unknown';
}

async function normalize(body: IngestBody): Promise<NormalizedFinding[]> {
  const findings: NormalizedFinding[] = [];
  const runId = typeof body.run_id === 'string' ? parseInt(body.run_id, 10) : body.run_id;

  for (const run of body.sarif?.runs ?? []) {
    const rules = run.tool?.driver?.rules ?? [];
    const rulesByIndex = new Map<number, SarifRule>(rules.map((r, i) => [i, r]));
    const rulesById = new Map<string, SarifRule>(rules.map((r) => [r.id, r]));

    for (const result of run.results ?? []) {
      const rule = (result.ruleId ? rulesById.get(result.ruleId) : undefined)
        ?? (typeof result.ruleIndex === 'number' ? rulesByIndex.get(result.ruleIndex) : undefined);

      const ruleId = result.ruleId ?? rule?.id ?? 'unknown';
      const ruleName = rule?.name ?? rule?.shortDescription?.text ?? null;
      const severity = pickSeverity(result, rule);
      const message = result.message?.text ?? '';
      const loc = result.locations?.[0]?.physicalLocation;
      const path = loc?.artifactLocation?.uri ?? '';
      const startLine = loc?.region?.startLine ?? 0;

      const fingerprint = await sha256Hex(
        `${body.scanner}:${ruleId}:${path}:${startLine}:${body.branch}`,
      );

      findings.push({
        scanner: body.scanner,
        branch: body.branch,
        commit_sha: body.commit_sha,
        run_id: runId,
        rule_id: ruleId,
        rule_name: ruleName,
        severity,
        message,
        path,
        start_line: startLine,
        fingerprint,
        raw: result,
      });
    }
  }
  return findings;
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
  if (!ALLOWED_SCANNERS.has(body.scanner)) {
    return jsonResponse({ error: 'unknown_scanner', allowed: [...ALLOWED_SCANNERS] }, 400);
  }
  if (!body.branch || typeof body.branch !== 'string') {
    return jsonResponse({ error: 'branch_required' }, 400);
  }
  if (!body.commit_sha || !/^[0-9a-f]{40}$/i.test(body.commit_sha)) {
    return jsonResponse({ error: 'invalid_commit_sha' }, 400);
  }
  if (!body.sarif || typeof body.sarif !== 'object') {
    return jsonResponse({ error: 'sarif_required' }, 400);
  }

  try {
    const findings = await normalize(body);
    const ingestStartedAt = new Date().toISOString();
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Upsert all findings. ON CONFLICT (scanner, branch, fingerprint) updates
    // last_seen_at + revives any previously-resolved finding.
    let upserted = 0;
    if (findings.length > 0) {
      const rows = findings.map((f) => ({
        scanner: f.scanner,
        branch: f.branch,
        commit_sha: f.commit_sha,
        run_id: f.run_id,
        rule_id: f.rule_id,
        rule_name: f.rule_name,
        severity: f.severity,
        message: f.message,
        path: f.path,
        start_line: f.start_line,
        fingerprint: f.fingerprint,
        state: 'open',
        last_seen_at: ingestStartedAt,
        resolved_at: null,
        raw: f.raw,
      }));

      // PostgREST upsert: on conflict update the lifecycle fields.
      // first_seen_at is preserved across upserts (NOT in the update list).
      const { error: upsertError } = await supabase
        .from('sarif_findings')
        .upsert(rows, { onConflict: 'scanner,branch,fingerprint' });

      if (upsertError) {
        console.error('[ingest-sarif] upsert failed:', upsertError.message);
        return jsonResponse({ error: 'upsert_failed', detail: upsertError.message }, 500);
      }
      upserted = rows.length;
    }

    // Anything that was open for this (scanner, branch) but not seen in this
    // run is now considered resolved. last_seen_at < ingestStartedAt is the
    // cleanest signal — upserts above bumped last_seen_at on every still-open
    // finding to ingestStartedAt.
    const { data: resolvedRows, error: resolveError } = await supabase
      .from('sarif_findings')
      .update({ state: 'resolved', resolved_at: ingestStartedAt })
      .eq('scanner', body.scanner)
      .eq('branch', body.branch)
      .eq('state', 'open')
      .lt('last_seen_at', ingestStartedAt)
      .select('id');

    if (resolveError) {
      console.error('[ingest-sarif] resolve failed:', resolveError.message);
      return jsonResponse({ error: 'resolve_failed', detail: resolveError.message }, 500);
    }

    return jsonResponse({
      ok: true,
      scanner: body.scanner,
      branch: body.branch,
      run_id: body.run_id,
      upserted,
      resolved: resolvedRows?.length ?? 0,
    }, 200);
  } catch (err) {
    console.error('[ingest-sarif] unhandled error:', err);
    return jsonResponse({ error: 'internal_error', message: String(err) }, 500);
  }
});
