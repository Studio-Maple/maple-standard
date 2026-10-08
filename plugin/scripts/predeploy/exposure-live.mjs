/**
 * exposure-live.mjs - the live half of the stack-exposure standard (D072, docs/stack-exposure.md), run by
 * `predeploy-gate --live` before ZAP starts (so a WAF reacting to the active scan cannot hide anything).
 *
 * Every request is ANONYMOUS: no configured auth header is ever sent, because the question is what a stranger
 * sees. Only GET/HEAD/OPTIONS by default; a configured POST probe carries a deliberately malformed body.
 * Probe paths matching `liveScan.callOriginationExcludes` are refused (the no-PSTN guard holds here too).
 *
 * Per target: the target URL and a fixed not-found path (`/__maple-exposure-probe`), plus configured probes.
 * Findings (check `live-scan`, id `exposure:<rule>`, location = the probed URL, stable across runs):
 *   x-powered-by       any X-Powered-By header
 *   server-version     a Server header carrying a version ("nginx/1.24.0", "Apache/2.4")
 *   version-header     X-AspNet-Version, X-Generator, X-App-Version, X-Commit, ... or a header holding the deployed SHA
 *   via-version        a Via header naming product/version
 *   server-banner      a body naming server/version ("<center>nginx/1.24.0</center>")
 *   stack-trace        a body with a stack trace (node/V8 frames, Python traceback, Java/.NET exceptions)
 *   framework-error    a body with a framework's default error ("Cannot GET /", FST_ERR_*, Whitelabel, SQLSTATE)
 *   forbidden-body     a body matching an `exposure.live.forbiddenBody` regex
 * Optional `exposure.live.loginGraph { target, path, maxFiles?, maxBytes?, markers?, allowCode? }`: crawl the
 * login page anonymously, following every same-origin static reference (HTML attributes, JS imports, CSS url()),
 * and report login-graph-files / -bytes / -code / -marker plus the bundle text rules (banner, env dump, SHA, ...).
 */
import { DEFAULT_LOGIN_BUDGET, envDumpPattern, textRules } from "./exposure.mjs";

export const NOT_FOUND_PROBE = "/__maple-exposure-probe";
const MAX_BODY = 512 * 1024;
const MAX_CRAWL = 500;
const VERSION_HEADERS = ["x-aspnet-version", "x-aspnetmvc-version", "x-generator", "x-runtime-version", "x-version", "x-app-version", "x-application-version", "x-build", "x-build-version", "x-commit", "x-git-sha", "x-git-commit", "x-release", "x-revision", "x-powered-by-plesk", "x-drupal-cache", "x-turbo-charged-by", "x-jenkins", "x-varnish-version"];
const BODY_RULES = [
  ["server-banner", /\b(?:nginx|Apache|Microsoft-IIS|openresty|lighttpd|Caddy|gunicorn|uvicorn|Jetty|Apache-Coyote|Tomcat|Kestrel|Werkzeug|Express|LiteSpeed|Envoy)\/\s?v?\d+(?:\.\d+)+/i],
  ["stack-trace", /\n\s*at [\w$.<>[\]\s]+ \((?:file:\/\/|\/|[A-Za-z]:\\|webpack:|node:)[^)\n]*:\d+:\d+\)|Traceback \(most recent call last\)|\bat (?:java|javax|org\.springframework|System)\.[\w.$]+\(|\bSystem\.[A-Za-z.]+Exception\b/],
  ["framework-error", /\bFST_ERR_[A-Z_]+|Cannot (?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS) \/|Whitelabel Error Page|SQLSTATE\[|node_modules[/\\]|\bDatabaseError\b|\bReplyError\b|\bECONNREFUSED\b|Django Version:|<b>Fatal error<\/b>/],
];
const REF = /(?:["'`(]|^)((?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)*[\w@.-]+\.(?:m?js|css|woff2?|ttf|png|jpe?g|svg|webp|wasm|json))(?:\?[^"'`)\s]*)?(?=["'`)])/gm;

const F = (id, message, location, severity = "medium") => ({ check: "live-scan", id: `exposure:${id}`, severity, message: String(message).slice(0, 300), location });
const hdr = (headers, name) => (typeof headers?.get === "function" ? headers.get(name) : headers?.[name]) || "";

/** Pure: findings for one response. `headers` is a Headers object or a lower-cased plain object. */
export function responseFindings({ url, headers, body = "", sha = "", forbiddenBody = [] }) {
  const out = [];
  const pb = hdr(headers, "x-powered-by");
  if (pb) out.push(F("x-powered-by", `X-Powered-By: ${pb}`, url));
  const server = hdr(headers, "server");
  if (/\d/.test(server)) out.push(F("server-version", `Server: ${server}`, url));
  for (const h of VERSION_HEADERS) { const v = hdr(headers, h); if (v) out.push(F("version-header", `${h}: ${v}`, url)); }
  if (sha) {
    const all = typeof headers?.forEach === "function" ? (() => { const a = []; headers.forEach((v, k) => a.push([k, v])); return a; })() : Object.entries(headers || {});
    for (const [k, v] of all) if (String(v).includes(sha) || String(v).includes(sha.slice(0, 12))) out.push(F("version-header", `${k} carries the deployed commit SHA`, url));
  }
  const via = hdr(headers, "via");
  if (/[A-Za-z][\w-]*\/\d/.test(via)) out.push(F("via-version", `Via: ${via}`, url));
  const text = String(body).slice(0, MAX_BODY);
  for (const [id, re] of BODY_RULES) { const m = re.exec(text); if (m) out.push(F(id, `body contains "${m[0].trim().slice(0, 80)}"`, url)); }
  for (const rx of forbiddenBody) { const m = new RegExp(rx).exec(text); if (m) out.push(F("forbidden-body", `body matches ${rx}: "${m[0].slice(0, 80)}"`, url)); }
  return out;
}

/** Pure: the anonymous probe list for the configured targets. Refuses call-origination paths. */
export function probePlan(ls, live = {}) {
  const callEx = (ls.callOriginationExcludes || []).map((r) => new RegExp(r));
  const plan = [];
  const refused = [];
  for (const t of ls.targets) {
    const origin = new URL(t.url).origin;
    const probes = [{ url: t.url, method: "GET" }, { url: origin + NOT_FOUND_PROBE, method: "GET" }];
    for (const p of live.probes || []) if (!p.target || p.target === t.id) probes.push({ url: origin + p.path, method: p.method || "GET", body: p.body });
    for (const p of probes) {
      const path = new URL(p.url).pathname;
      if (callEx.some((re) => re.test(path))) refused.push(F("probe-refused", `probe ${p.method} ${path} matches callOriginationExcludes - not sent (no-PSTN guard)`, p.url, "info"));
      else plan.push({ ...p, target: t.id });
    }
  }
  return { plan, refused };
}

async function fetchText(fetchImpl, url, { method = "GET", body } = {}) {
  const init = { method, redirect: "manual", signal: AbortSignal.timeout(20000) };
  if (method === "POST") Object.assign(init, { body: body ?? "{", headers: { "content-type": "application/json" } });
  const res = await fetchImpl(url, init);
  const ct = res.headers.get("content-type") || "";
  const textual = method !== "HEAD" && (/text|json|xml|javascript|css|html/.test(ct) || !ct);
  const buf = textual ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
  if (!textual && res.body) await res.body.cancel?.();
  return { status: res.status, headers: res.headers, ct, bytes: Number(res.headers.get("content-length")) || buf.length, text: buf.toString("utf8") };
}

/** Anonymous same-origin crawl from the login page (the reachable set an unauthenticated scanner gets). */
export async function crawlLogin(fetchImpl, startUrl) {
  const origin = new URL(startUrl).origin;
  const files = new Map();
  const queue = [startUrl];
  while (queue.length && files.size < MAX_CRAWL) {
    const url = queue.shift();
    const key = new URL(url).pathname;
    if (files.has(key)) continue;
    let r;
    try { r = await fetchText(fetchImpl, url); } catch (x) { files.set(key, { path: key, status: 0, bytes: 0, text: "", error: x.message }); continue; }
    files.set(key, { path: key, status: r.status, bytes: r.bytes, text: r.status === 200 ? r.text : "", ct: r.ct });
    if (r.status !== 200 || !r.text) continue;
    for (const m of r.text.matchAll(REF)) {
      const spec = m[1];
      let target;
      if (/^(\/|\.\.?\/)/.test(spec)) target = new URL(spec, url);
      else if (spec.startsWith("assets/")) target = new URL("/" + spec, origin);
      else continue;
      if (target.origin !== origin) continue;
      target.search = ""; target.hash = "";
      if (!files.has(target.pathname)) queue.push(target.href);
    }
  }
  return [...files.values()].filter((f) => f.status === 200);
}

/** Pure: budget + marker + text-rule findings for a crawl result. */
export function loginGraphFindings(reached, g, { origin, sha, envRe }) {
  const loc = origin + g.path;
  const budget = { ...DEFAULT_LOGIN_BUDGET, ...g };
  const out = [];
  const bytes = reached.reduce((n, f) => n + f.bytes, 0);
  if (reached.length > budget.maxFiles) out.push(F("login-graph-files", `an anonymous load of ${g.path} reaches ${reached.length} files (budget ${budget.maxFiles})`, loc));
  if (bytes > budget.maxBytes) out.push(F("login-graph-bytes", `an anonymous load of ${g.path} reaches ${bytes} bytes (budget ${budget.maxBytes})`, loc));
  const code = reached.filter((f) => /\.(m?js|css)$/.test(f.path));
  if (g.allowCode === false && code.length) out.push(F("login-graph-code", `anonymous visitors can fetch ${code.length} JS/CSS file(s) (allowCode: false), e.g. ${code.slice(0, 3).map((f) => f.path).join(", ")}`, loc));
  const seen = new Set();
  for (const f of reached) {
    if (!f.text) continue;
    for (const mk of g.markers || []) if (f.text.includes(mk) && !seen.has("m" + mk)) { seen.add("m" + mk); out.push(F("login-graph-marker", `app-only marker "${mk}" is reachable anonymously (${f.path})`, loc)); }
    for (const h of textRules(f.text, { envRe, shas: sha ? [sha, sha.slice(0, 12)] : [] })) {
      if (seen.has(h.rule + h.key)) continue;
      seen.add(h.rule + h.key);
      out.push(F(`login-${h.rule}`, `${h.detail} in ${f.path}`, loc));
    }
  }
  return out;
}

/**
 * Run the live exposure probes. Returns { findings, notes }. `ledger` = ledgerDecisionIds() (only read for an opt-out).
 */
export async function liveExposure(pd, ls, { sha = "", ledger, fetchImpl = fetch } = {}) {
  const oo = pd.exposure?.optOut?.live;
  if (oo) {
    if (ledger?.error || !ledger?.ids?.has(oo.decision)) return { findings: [{ check: "exposure-standard", id: "exposure-optout-decision-missing", severity: "high", message: `live exposure opt-out names ${oo.decision}, which is not in the decisions ledger${ledger?.error ? ` (${ledger.error})` : ""}`, location: "maple.config.json#predeploy.exposure.optOut.live" }], notes: [] };
    return { findings: [], notes: [`live exposure probes OPTED OUT by ${oo.decision}`] };
  }
  const live = pd.exposure?.live || {};
  const { plan, refused } = probePlan(ls, live);
  const findings = [...refused];
  for (const p of plan) {
    try {
      const r = await fetchText(fetchImpl, p.url, p);
      findings.push(...responseFindings({ url: p.url, headers: r.headers, body: r.text, sha, forbiddenBody: live.forbiddenBody || [] }));
    } catch (x) {
      findings.push(F("probe-failed", `${p.method} ${p.url}: ${x.message} - an unanswered probe is not a clean probe`, p.url, "high"));
    }
  }
  const g = live.loginGraph;
  if (g) {
    const t = ls.targets.find((x) => x.id === g.target);
    const origin = new URL(t.url).origin;
    const reached = await crawlLogin(fetchImpl, origin + g.path);
    if (!reached.length) findings.push(F("login-graph-unreachable", `${g.path} did not answer 200 anonymously`, origin + g.path, "high"));
    else findings.push(...loginGraphFindings(reached, g, { origin, sha, envRe: envDumpPattern() }));
  }
  return { findings, notes: [`live exposure: ${plan.length} anonymous probe(s)${g ? ` + login crawl of ${g.path}` : ""}`] };
}
