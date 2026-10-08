/**
 * targetcheck.mjs - live-scan target reachability preflight.
 *
 * A ZAP scan of a target that is parked/down does not fail: the edge answers with its own error page
 * (Cloudflare 530 tunnel down, 522 origin timeout, ...) and ZAP happily reports header findings
 * (HSTS missing, ...) about THAT page. Such a result is noise, not a verdict on the app. This module
 * probes every target BEFORE Docker/ZAP starts and classifies the answer:
 *
 *   up           - the app (or any real origin response) answered; scan it
 *   down         - connection failure, or an edge error page (Cloudflare 52x / 530 / 1xxx, CF 502-504 pages)
 *   access-wall  - only a Cloudflare Access login answered AND the target has no auth headers configured,
 *                  so a scan would test the login wall, not the app (authenticated targets are checked
 *                  with their credentials by the container preflight in livescan.mjs, not here)
 *
 * Any non-"up" target aborts the scan with a blocking `target-down:<id>` finding ("scan not meaningful").
 * An optional `schedule` ({ days, from, to, tz }) on liveScan or a target adds a note when "now" is outside
 * the window the target is declared to be up, since that is the usual cause of a parked target.
 */

export const PROBE_TIMEOUT_MS = 15000;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const CF_PAGE = /cloudflare|cf-error|error code:\s*\d{3,4}|error\s+(?:5\d\d|10\d\d)\b/i;
const EDGE_DOWN_STATUS = new Set([520, 521, 522, 523, 524, 525, 526, 527, 530]);
const GATEWAY_STATUS = new Set([502, 503, 504]);

const hdr = (headers, name) => {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const k = Object.keys(headers).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? String(headers[k]) : "";
};

/** Pure: the CF error code in an edge page body ("error code: 1033", "Error 522"), else "". */
const cfCode = (body) => (/error code:\s*(\d{3,4})/i.exec(body) || /\bError\s+(5\d\d|10\d\d)\b/.exec(body) || [])[1] || "";

/**
 * Pure: classify one probe result.
 * @param {{status?:number, headers?:object, body?:string, error?:string}} r
 * @param {{authenticated?:boolean}} [opts] authenticated = the target has auth headers configured
 * @returns {{state:"up"|"down"|"access-wall", kind:string, reason:string}}
 */
export function classifyResponse(r, { authenticated = false } = {}) {
  if (r.error) return { state: "down", kind: "connection-failed", reason: `no response (${r.error})` };
  const status = r.status || 0;
  const body = String(r.body || "").slice(0, 8192);
  const server = hdr(r.headers, "server").toLowerCase();
  const location = hdr(r.headers, "location");
  const cfEdge = server.includes("cloudflare") || !!hdr(r.headers, "cf-ray") || CF_PAGE.test(body);
  if (EDGE_DOWN_STATUS.has(status)) {
    const code = cfCode(body);
    return { state: "down", kind: `edge-${status}`, reason: `edge error page HTTP ${status}${code && code !== String(status) ? ` (error code ${code})` : ""}${status === 530 ? " - tunnel/origin down" : status === 522 || status === 524 ? " - origin timeout" : ""}` };
  }
  if (GATEWAY_STATUS.has(status) && cfEdge && /cf-error|error code:|cloudflare/i.test(body)) {
    return { state: "down", kind: `edge-${status}`, reason: `edge gateway error page HTTP ${status} - origin unavailable` };
  }
  if (/cloudflareaccess\.com/i.test(location) || ((status === 401 || status === 403) && /cloudflare access|cf-access|cloudflareaccess\.com/i.test(body + hdr(r.headers, "cf-access-domain")))) {
    if (!authenticated) return { state: "access-wall", kind: "access-wall", reason: `only the Cloudflare Access login answered (HTTP ${status}${location ? " -> " + location.split("?")[0] : ""}) and no auth headers are configured for this target` };
  }
  return { state: "up", kind: "up", reason: `HTTP ${status}` };
}

/** Real probe: one GET, no redirect following, bounded; never throws. */
export async function probeTarget(url, { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS, userAgent } = {}) {
  try {
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: userAgent ? { "user-agent": userAgent } : {} });
    let body = "";
    try { body = (await res.text()).slice(0, 8192); } catch { /* body is optional evidence */ }
    return { status: res.status, headers: res.headers, body };
  } catch (e) {
    const c = e?.cause;
    const why = [c?.code, c?.message || e?.message].filter(Boolean).join(" ");
    return { error: (e?.name === "TimeoutError" ? `timeout after ${timeoutMs}ms` : why) || "fetch failed" };
  }
}

/** Pure: schedule { days:["sun".."thu"], from:"06:45", to:"21:00", tz:"Asia/Jerusalem" } -> is `now` inside it? null if no/invalid schedule. */
export function scheduleState(schedule, now = new Date()) {
  if (!schedule) return null;
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: schedule.tz || "UTC", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((p) => [p.type, p.value]));
  } catch { return null; }
  const day = String(parts.weekday).slice(0, 3).toLowerCase();
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  const toMin = (s) => { const [h, m] = String(s).split(":").map(Number); return h * 60 + m; };
  const days = (schedule.days || DAYS).map((d) => String(d).toLowerCase().slice(0, 3));
  const inside = days.includes(day) && mins >= toMin(schedule.from || "00:00") && mins < toMin(schedule.to || "24:00");
  return { inside, label: `${days.join(",")} ${schedule.from || "00:00"}-${schedule.to || "24:00"} ${schedule.tz || "UTC"}` };
}

/** Pure: the per-target note, or "" when no schedule is declared. */
export function scheduleNote(schedule, now = new Date()) {
  const s = scheduleState(schedule, now);
  if (!s) return "";
  return s.inside
    ? ` Declared schedule (${s.label}) says it should be up now - this is an unexpected outage.`
    : ` Now is outside its declared schedule (${s.label}) - it is probably parked on purpose; re-run the live scan inside that window.`;
}

/**
 * Probe every target; returns { findings, results }. findings are blocking `target-down:<id>` entries
 * (empty when all targets are up). `probe` is injectable for tests.
 */
export async function checkTargets(ls, { probe = probeTarget, now = new Date(), probeOpts = {} } = {}) {
  const results = await Promise.all(ls.targets.map(async (t) => {
    const first = await probe(t.url, { ...probeOpts, userAgent: ls.userAgent });
    let r = first;
    if (first.error) r = await probe(t.url, { ...probeOpts, userAgent: ls.userAgent }); // one retry for a transient reset
    const c = classifyResponse(r, { authenticated: (t.headers || []).length > 0 });
    return { id: t.id, url: t.url, ...c, note: c.state === "up" ? "" : scheduleNote(t.schedule || ls.schedule, now) };
  }));
  const findings = results.filter((x) => x.state !== "up").map((x) => ({
    check: "live-scan", id: `target-down:${x.id}`, severity: "high", location: x.url,
    message: `target ${x.id} is ${x.state === "down" ? "down" : "behind Cloudflare Access only"} - scan not meaningful (${x.reason}).${x.note} No ZAP scan was run; findings about an error page would say nothing about the app.`,
  }));
  return { findings, results };
}
