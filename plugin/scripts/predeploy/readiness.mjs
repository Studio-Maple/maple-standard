// readiness.mjs - wait for a live-scan target's origin to be READY before the active scan starts.
//
// targetcheck.mjs only proves the edge answers with something that is not an error page. A VM that is still booting
// can answer a real page (or a half-up app) and then drop back, and ZAP then reports header findings about the edge
// error pages it saw (round: HSTS missing x5 on a 52x page). A target that declares `readyPath` (e.g. "/readyz") is
// polled until that path returns 200 for `stableMs` in a row; one non-200 or a connection error resets the streak.
// A target that never gets there blocks the scan with `target-not-ready:<id>` (high): never a pass, never a skip.
// No readyPath = no wait (the previous behaviour).

export const READY_STABLE_MS = 30000;
export const READY_TIMEOUT_MS = 10 * 60000;
export const READY_INTERVAL_MS = 3000;
const PROBE_MS = 10000;

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/** Real probe: one GET with the given headers, no redirect following; never throws. Returns { status } or { error }. */
export async function probeReady(url, headers = {}, { fetchImpl = globalThis.fetch, timeoutMs = PROBE_MS } = {}) {
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", headers, signal: AbortSignal.timeout(timeoutMs) });
    try { await res.arrayBuffer(); } catch { /* body is not needed */ }
    return { status: res.status };
  } catch (e) {
    return { error: e?.name === "TimeoutError" ? `timeout after ${timeoutMs}ms` : [e?.cause?.code, e?.cause?.message || e?.message].filter(Boolean).join(" ") || "fetch failed" };
  }
}

const originOf = (u) => u.replace(/^(https?:\/\/[^/]+).*$/, "$1");

/**
 * Wait for every target with a readyPath. `headersFor(target)` returns the request headers (the scan's own auth headers,
 * so an Access-protected /readyz can be reached). Clock, sleep and probe are injectable for tests.
 * @returns {Promise<{findings:object[], results:object[]}>} findings are blocking `target-not-ready:<id>` entries.
 */
export async function waitForReady(ls, { headersFor = () => ({}), probe = probeReady, now = () => Date.now(), sleep = sleepReal, stableMs = READY_STABLE_MS, timeoutMs = READY_TIMEOUT_MS, intervalMs = READY_INTERVAL_MS, log = () => {} } = {}) {
  const targets = ls.targets.filter((t) => t.readyPath);
  const results = await Promise.all(targets.map(async (t) => {
    const url = originOf(t.url) + t.readyPath;
    const headers = headersFor(t);
    const start = now();
    let streakFrom = null;
    let last = "no probe";
    for (;;) {
      const r = await probe(url, headers);
      if (r.status === 200) { if (streakFrom === null) streakFrom = now(); last = "HTTP 200"; }
      else { streakFrom = null; last = r.error ? `no response (${r.error})` : `HTTP ${r.status}`; }
      if (streakFrom !== null && now() - streakFrom >= stableMs) {
        log(`  target ${t.id}: ${t.readyPath} ready (HTTP 200 for ${Math.round((now() - streakFrom) / 1000)}s, waited ${Math.round((now() - start) / 1000)}s)`);
        return { id: t.id, url, ready: true, waitedMs: now() - start };
      }
      if (now() - start >= timeoutMs) return { id: t.id, url, ready: false, waitedMs: now() - start, reason: last };
      await sleep(intervalMs);
    }
  }));
  const findings = results.filter((x) => !x.ready).map((x) => ({
    check: "live-scan", id: `target-not-ready:${x.id}`, severity: "high", location: x.url,
    message: `target ${x.id} did not become ready: ${x.url} was not HTTP 200 for ${Math.round(stableMs / 1000)}s within ${Math.round(timeoutMs / 60000)} min (last: ${x.reason}). No ZAP scan was run; findings about a half-started origin or an edge error page would say nothing about the app. Re-run the live scan once the origin is up.`,
  }));
  return { findings, results };
}
