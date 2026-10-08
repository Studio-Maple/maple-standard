/**
 * exposure-config.mjs - config validation and coverage for the stack-exposure standard (D072,
 * docs/stack-exposure.md).
 *
 * The standard is ON by default for every project with a `predeploy` block:
 *   - build side: a check with `preset: "stack-exposure"` must exist, or
 *     `predeploy.exposure.optOut.bundle = { decision: "D###", why }` must say why not (a pure API, no web build);
 *   - live side: when `predeploy.liveScan` runs, the exposure probes run with it, unless
 *     `predeploy.exposure.optOut.live = { decision, why }`.
 * An opt-out's decision id must exist in the project's decisions ledger (docs.decisions), like a decision-backed
 * exception. Individual rules are never switched off by config: an unavoidable item (React's runtime version
 * check, a platform's own header) is one entry in predeploy-decisions.json, scoped to that item.
 */
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const isStrList = (v) => Array.isArray(v) && v.every(isStr);
const SWALLOW = /\|\|\s*(true|:|exit\s+0|echo\b)|;\s*(true|exit\s+0)\s*$/;
const REL_PATH = /^(?![/\\])(?![A-Za-z]:)(?!.*(^|[/\\])\.\.([/\\]|$))[^\0"`;|<>\r\n]+$/;
export const OPT_OUT_KINDS = ["bundle", "live"];
export const LIVE_METHODS = ["GET", "HEAD", "OPTIONS", "POST"];

function validateOptOut(oo, e) {
  if (!isObj(oo)) return e.push("predeploy.exposure.optOut: object { bundle?, live? }");
  for (const k of Object.keys(oo)) {
    if (!OPT_OUT_KINDS.includes(k)) { e.push(`predeploy.exposure.optOut.${k}: unknown key (bundle | live)`); continue; }
    const v = oo[k];
    if (!isObj(v) || Object.keys(v).some((x) => !["decision", "why"].includes(x))) { e.push(`predeploy.exposure.optOut.${k}: { decision: "D###", why }`); continue; }
    if (!/^D\d+$/.test(String(v.decision))) e.push(`predeploy.exposure.optOut.${k}.decision: a decision id like D123 (it must exist in the decisions ledger)`);
    if (!isStr(v.why) || v.why.trim().length < 20 || v.why.length > 600) e.push(`predeploy.exposure.optOut.${k}.why: why this project cannot meet the standard (20-600 chars)`);
  }
}

function validateLoginGraph(g, at, e, { needsTarget }) {
  if (!isObj(g)) return e.push(`${at}: object`);
  const keys = needsTarget ? ["target", "path", "maxFiles", "maxBytes", "markers", "allowCode"] : ["maxFiles", "maxBytes"];
  for (const k of Object.keys(g)) if (!keys.includes(k)) e.push(`${at}.${k}: unknown key`);
  for (const k of ["maxFiles", "maxBytes"]) if (g[k] !== undefined && !(Number.isInteger(g[k]) && g[k] >= 1)) e.push(`${at}.${k}: positive integer`);
  if (!needsTarget) return;
  if (!isStr(g.target)) e.push(`${at}.target: the liveScan target id whose origin serves the login page`);
  if (!isStr(g.path) || !g.path.startsWith("/")) e.push(`${at}.path: absolute URL path of the login page, e.g. "/login"`);
  if (g.markers !== undefined && !isStrList(g.markers)) e.push(`${at}.markers: array of strings that exist only in app code`);
  if (g.allowCode !== undefined && typeof g.allowCode !== "boolean") e.push(`${at}.allowCode: boolean`);
}

function validateLive(l, e, targetIds) {
  if (!isObj(l)) return e.push("predeploy.exposure.live: object { probes?, forbiddenBody?, loginGraph? }");
  for (const k of Object.keys(l)) if (!["probes", "forbiddenBody", "loginGraph"].includes(k)) e.push(`predeploy.exposure.live.${k}: unknown key`);
  (l.probes || []).forEach((p, i) => {
    const at = `predeploy.exposure.live.probes[${i}]`;
    if (!isObj(p) || !isStr(p.path) || !p.path.startsWith("/")) return e.push(`${at}: { path: "/...", method?, body?, target? }`);
    for (const k of Object.keys(p)) if (!["path", "method", "body", "target"].includes(k)) e.push(`${at}.${k}: unknown key`);
    if (p.method !== undefined && !LIVE_METHODS.includes(p.method)) e.push(`${at}.method: one of ${LIVE_METHODS.join("|")}`);
    if (p.body !== undefined && typeof p.body !== "string") e.push(`${at}.body: string`);
    if (p.target !== undefined && !targetIds.includes(p.target)) e.push(`${at}.target: not a liveScan target id`);
  });
  if (l.probes !== undefined && !Array.isArray(l.probes)) e.push("predeploy.exposure.live.probes: array");
  if (l.forbiddenBody !== undefined) {
    if (!isStrList(l.forbiddenBody)) e.push("predeploy.exposure.live.forbiddenBody: array of regex strings");
    else for (const rx of l.forbiddenBody) try { new RegExp(rx); } catch (x) { e.push(`predeploy.exposure.live.forbiddenBody: ${x.message}`); }
  }
  if (l.loginGraph !== undefined) {
    validateLoginGraph(l.loginGraph, "predeploy.exposure.live.loginGraph", e, { needsTarget: true });
    if (isStr(l.loginGraph?.target) && targetIds.length && !targetIds.includes(l.loginGraph.target)) e.push("predeploy.exposure.live.loginGraph.target: not a liveScan target id");
  }
}

function validateSurface(s, at, e, names) {
  if (!isObj(s)) return e.push(`${at}: object`);
  const keys = ["name", "dir", "build", "buildTimeoutSec", "exclude", "hashOnly", "loginEntry", "loginBudget"];
  for (const k of Object.keys(s)) if (!keys.includes(k)) e.push(`${at}.${k}: unknown key`);
  if (!isStr(s.name) || !/^[a-z0-9][a-z0-9-]*$/.test(s.name)) e.push(`${at}.name: kebab-case`);
  else if (names.has(s.name)) e.push(`${at}.name: duplicate`); else names.add(s.name);
  if (!isStr(s.dir) || !REL_PATH.test(s.dir) || /\/$/.test(s.dir)) e.push(`${at}.dir: repo-relative directory of the built, served files (e.g. app/dist)`);
  if (!isStr(s.build)) e.push(`${at}.build: the command that builds this surface (the gate scans a fresh build of the candidate, never a stale dir)`);
  else if (SWALLOW.test(s.build)) e.push(`${at}.build: swallows its own failure - silent thresholds are not allowed`);
  if (s.buildTimeoutSec !== undefined && !(Number.isInteger(s.buildTimeoutSec) && s.buildTimeoutSec >= 1)) e.push(`${at}.buildTimeoutSec: positive integer`);
  if (s.exclude !== undefined && !(isStrList(s.exclude) && s.exclude.every((x) => REL_PATH.test(x)))) e.push(`${at}.exclude: array of paths inside dir that the host never serves (e.g. "_worker.js")`);
  if (s.hashOnly !== undefined) {
    const h = s.hashOnly;
    if (!isObj(h) || !isStr(h.dir) || Object.keys(h).some((k) => !["dir", "pattern"].includes(k))) e.push(`${at}.hashOnly: { dir, pattern? } (default { dir: "assets" }); it cannot be turned off - an unavoidable case is a decision-backed exception`);
    else if (h.pattern !== undefined) try { new RegExp(h.pattern); } catch (x) { e.push(`${at}.hashOnly.pattern: ${x.message}`); }
  }
  if (s.loginEntry !== undefined && (!isStr(s.loginEntry) || !REL_PATH.test(s.loginEntry))) e.push(`${at}.loginEntry: path of the login HTML inside dir (static builds)`);
  if (s.loginBudget !== undefined) validateLoginGraph(s.loginBudget, `${at}.loginBudget`, e, { needsTarget: false });
}

/** Options of a `preset: "stack-exposure"` check. */
export function validateStackExposureOptions(o, at) {
  const e = [];
  if (!isObj(o)) return [`${at}.options: { surfaces: [...] } required`];
  const keys = ["surfaces", "envPrefixes", "devRoutes", "forbidden", "appMarkers", "shaPrefix"];
  for (const k of Object.keys(o)) if (!keys.includes(k)) e.push(`${at}.options.${k}: unknown key`);
  if (!Array.isArray(o.surfaces) || !o.surfaces.length) e.push(`${at}.options.surfaces: required non-empty array of { name, dir, build, ... }`);
  else { const names = new Set(); o.surfaces.forEach((s, i) => validateSurface(s, `${at}.options.surfaces[${i}]`, e, names)); }
  for (const k of ["envPrefixes", "devRoutes", "forbidden", "appMarkers"]) if (o[k] !== undefined && !isStrList(o[k])) e.push(`${at}.options.${k}: array of non-empty strings`);
  if (o.shaPrefix !== undefined && !(Number.isInteger(o.shaPrefix) && o.shaPrefix >= 7 && o.shaPrefix <= 40)) e.push(`${at}.options.shaPrefix: integer 7..40 (default 12)`);
  return e;
}

/** `predeploy.exposure` + every stack-exposure check's options. */
export function validateExposure(p) {
  const e = [];
  const ex = p.exposure;
  const targetIds = (Array.isArray(p.liveScan?.targets) ? p.liveScan.targets : []).map((t) => t?.id).filter(isStr);
  if (ex !== undefined) {
    if (!isObj(ex)) e.push("predeploy.exposure: object { optOut?, live? }");
    else {
      for (const k of Object.keys(ex)) if (!["optOut", "live"].includes(k)) e.push(`predeploy.exposure.${k}: unknown key`);
      if (ex.optOut !== undefined) validateOptOut(ex.optOut, e);
      if (ex.live !== undefined) validateLive(ex.live, e, targetIds);
      if (ex.live !== undefined && ex.optOut?.live) e.push("predeploy.exposure: live probes are configured AND opted out - pick one");
    }
  }
  (Array.isArray(p.checks) ? p.checks : []).forEach((c, i) => {
    if (c?.preset === "stack-exposure") e.push(...validateStackExposureOptions(c.options, `predeploy.checks[${i}]`));
  });
  return e;
}

const G = (id, message) => ({ check: "exposure-standard", id, severity: "high", message, location: "maple.config.json#predeploy.exposure" });

/** Gate bookkeeping findings: the standard is covered, or opted out with a real decision. `ledger` = ledgerDecisionIds(). */
export function exposureCoverage(pd, ledger, { kind = "bundle" } = {}) {
  const oo = pd?.exposure?.optOut?.[kind];
  const hasCheck = (pd?.checks || []).some((c) => c.preset === "stack-exposure");
  if (kind === "bundle" && !oo && !hasCheck) return [G("exposure-unconfigured", 'stack-exposure standard (D072 in maple-standard): add a { "preset": "stack-exposure" } check with options.surfaces, or opt out with predeploy.exposure.optOut.bundle { decision, why } naming a project decision')];
  if (!oo) return [];
  if (kind === "bundle" && hasCheck) return [G("exposure-optout-conflict", "predeploy.exposure.optOut.bundle is set but a stack-exposure check is configured - remove one")];
  if (ledger.error) return [G("exposure-optout-ledger-unreadable", `cannot verify opt-out decision ${oo.decision}: ${ledger.error}`)];
  if (!ledger.ids.has(oo.decision)) return [G("exposure-optout-decision-missing", `opt-out ${kind} names ${oo.decision}, which is not in the decisions ledger`)];
  return [];
}
