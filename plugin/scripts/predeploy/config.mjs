/**
 * config.mjs — `predeploy` block of maple.config.json: defaults, validation,
 * and the canonical hash that binds a stamp to its configuration.
 *
 * Validation is where "no silent thresholds" is enforced for the CONFIG:
 * a check command that swallows its own failure (`|| true`, `--exit-zero`,
 * `--no-exit-code`, `--max-warnings=<n>` with n>0 ...) is rejected outright.
 * Exceptions live in the allowlist file, with an owner and an expiry.
 */
import { canonicalJson, sha256, SEVERITIES } from "./lib.mjs";
import { PARSER_KINDS } from "./parsers.mjs";
import { PRESET_NAMES } from "./catalog.mjs";

export const DEFAULTS = {
  enabled: true,
  allowlist: "predeploy-allowlist.json",
  allowlistMaxDays: 90,
  stampTtlHours: 72,
  minSeverity: "info",
  concurrency: 4,
  docker: { enabled: true },
  emergency: { enabled: false, maxMinutes: 60 },
};

const SWALLOWERS = [
  [/\|\|\s*(true|:|exit\s+0|echo\b)/, "swallows failure with `|| true/:/echo`"],
  [/;\s*(true|exit\s+0)\s*$/, "ends in `; true` / `; exit 0`"],
  [/--exit-zero\b|--no-exit-code\b|--soft-fail\b|--no-fail\b|--exit-code[= ]0\b|continue-on-error/, "disables the tool's failing exit code"],
  [/--max-warnings[= ]([1-9]\d*)/, "allows warnings (--max-warnings must be 0)"],
  [/--audit-level[= ](moderate|high|critical)/, "raises the audit floor (all severities must count)"],
  [/--severity[= ](high|critical)/i, "raises the severity floor"],
];

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;

export function normalize(cfg) {
  const p = cfg?.predeploy;
  if (!isObj(p)) return null;
  return {
    ...DEFAULTS,
    ...p,
    docker: { ...DEFAULTS.docker, ...(p.docker || {}) },
    emergency: { ...DEFAULTS.emergency, ...(p.emergency || {}) },
    checks: p.checks || [],
    deployGuard: { enabled: true, patterns: [], ...(p.deployGuard || {}) },
  };
}

/** Hash of everything about the gate that a stamp must be bound to. */
export function configHash(pd) {
  return sha256(canonicalJson(pd));
}

export function validatePredeploy(cfg) {
  const e = [];
  const p = cfg?.predeploy;
  if (p === undefined) return e;
  if (!isObj(p)) return ["predeploy: must be an object"];
  const known = ["enabled", "policyRef", "allowlist", "allowlistMaxDays", "stampTtlHours", "minSeverity", "concurrency", "allowlistUnused", "docker", "checks", "remote", "deployGuard", "emergency", "liveScan"];
  for (const k of Object.keys(p)) if (!known.includes(k)) e.push(`predeploy.${k}: unknown key`);
  if (p.enabled !== undefined && typeof p.enabled !== "boolean") e.push("predeploy.enabled: must be a boolean");
  if (p.policyRef !== undefined && !isStr(p.policyRef)) e.push("predeploy.policyRef: must be a non-empty string (e.g. a decision id)");
  if (p.allowlist !== undefined && !isStr(p.allowlist)) e.push("predeploy.allowlist: must be a repo-relative path string");
  for (const k of ["allowlistMaxDays", "stampTtlHours", "concurrency"]) if (p[k] !== undefined && !(Number.isInteger(p[k]) && p[k] >= 1)) e.push(`predeploy.${k}: must be a positive integer`);
  if (p.allowlistUnused !== undefined && !["fail", "warn"].includes(p.allowlistUnused)) e.push("predeploy.allowlistUnused: fail | warn (default fail; warn only while a baseline allowlist is being burned down)");
  if (p.minSeverity !== undefined && !SEVERITIES.includes(p.minSeverity)) e.push(`predeploy.minSeverity: one of ${SEVERITIES.join("|")}`);

  const checks = p.checks;
  if (!Array.isArray(checks) || checks.length === 0) e.push("predeploy.checks: required non-empty array");
  else {
    const ids = new Set();
    checks.forEach((c, i) => {
      const at = `predeploy.checks[${i}]`;
      if (!isObj(c)) return e.push(`${at}: must be an object`);
      if (!isStr(c.id) || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) e.push(`${at}.id: kebab-case id required`);
      else if (ids.has(c.id)) e.push(`${at}.id: duplicate "${c.id}"`);
      else ids.add(c.id);
      const kinds = ["command", "preset", "github"].filter((k) => c[k] !== undefined);
      if (kinds.length !== 1) e.push(`${at}: exactly one of command | preset | github required (got ${kinds.join(",") || "none"})`);
      const allowed = ["id", "description", "command", "preset", "github", "options", "parse", "reports", "cwd", "env", "timeoutSec", "minSeverity", "tools", "why", "credentials", "countPattern"];
      for (const k of Object.keys(c)) if (!allowed.includes(k)) e.push(`${at}.${k}: unknown key`);
      if (c.preset !== undefined && !PRESET_NAMES.includes(c.preset)) e.push(`${at}.preset: unknown "${c.preset}" (known: ${PRESET_NAMES.join(", ")})`);
      if (c.command !== undefined) {
        if (!isStr(c.command)) e.push(`${at}.command: non-empty string`);
        else for (const [re, why] of SWALLOWERS) if (re.test(c.command)) e.push(`${at}.command: ${why} — silent thresholds are not allowed; use the allowlist`);
      }
      if (c.github !== undefined) {
        if (!/^[\w.-]+\.ya?ml$/.test(String(c.github))) e.push(`${at}.github: workflow file name (e.g. predeploy-remote.yml)`);
        if (!isStr(c.why) || c.why.trim().length < 20) e.push(`${at}.why: a github check must justify why it cannot run locally (>= 20 chars) — CI minutes are for remote-only work`);
      }
      if (c.parse !== undefined && !PARSER_KINDS.includes(c.parse)) e.push(`${at}.parse: one of ${PARSER_KINDS.join("|")}`);
      if (c.reports !== undefined && !(Array.isArray(c.reports) && c.reports.every(isStr))) e.push(`${at}.reports: array of file names under $PREDEPLOY_OUT`);
      if (c.minSeverity !== undefined && !SEVERITIES.includes(c.minSeverity)) e.push(`${at}.minSeverity: one of ${SEVERITIES.join("|")}`);
      if (c.countPattern !== undefined) { try { new RegExp(c.countPattern); } catch (x) { e.push(`${at}.countPattern: ${x.message}`); } }
      if (c.timeoutSec !== undefined && !(Number.isInteger(c.timeoutSec) && c.timeoutSec >= 1)) e.push(`${at}.timeoutSec: positive integer`);
      if (c.env !== undefined && !(isObj(c.env) && Object.values(c.env).every((v) => typeof v === "string"))) e.push(`${at}.env: object of strings`);
      if (c.tools !== undefined && !(Array.isArray(c.tools) && c.tools.every(isStr))) e.push(`${at}.tools: array of tool names`);
    });
    if (checks.some((c) => c?.github !== undefined)) {
      const r = p.remote;
      if (!isObj(r) || !isStr(r.workflow)) e.push("predeploy.remote.workflow: required when any check uses `github`");
    }
  }

  const r = p.remote;
  if (r !== undefined) {
    if (!isObj(r)) e.push("predeploy.remote: must be an object");
    else {
      for (const k of Object.keys(r)) if (!["workflow", "ref", "timeoutMin", "pollSec", "inputName"].includes(k)) e.push(`predeploy.remote.${k}: unknown key`);
      if (r.workflow !== undefined && !isStr(r.workflow)) e.push("predeploy.remote.workflow: string");
    }
  }

  const g = p.deployGuard;
  if (g !== undefined) {
    if (!isObj(g)) e.push("predeploy.deployGuard: must be an object");
    else {
      for (const k of Object.keys(g)) if (!["enabled", "patterns"].includes(k)) e.push(`predeploy.deployGuard.${k}: unknown key`);
      if (g.enabled === false) e.push("predeploy.deployGuard.enabled: false is not allowed — the gate is enforced, not advisory");
      (g.patterns || []).forEach((pt, i) => {
        const at = `predeploy.deployGuard.patterns[${i}]`;
        if (!isObj(pt) || !isStr(pt.id) || !isStr(pt.regex)) return e.push(`${at}: { id, regex } required`);
        try { new RegExp(pt.regex, "i"); } catch (x) { e.push(`${at}.regex: ${x.message}`); }
      });
    }
  }

  const em = p.emergency;
  if (em !== undefined) {
    if (!isObj(em)) e.push("predeploy.emergency: must be an object");
    else {
      for (const k of Object.keys(em)) if (!["enabled", "maxMinutes"].includes(k)) e.push(`predeploy.emergency.${k}: unknown key`);
      if (em.enabled !== undefined && typeof em.enabled !== "boolean") e.push("predeploy.emergency.enabled: boolean");
      if (em.maxMinutes !== undefined && !(Number.isInteger(em.maxMinutes) && em.maxMinutes >= 1 && em.maxMinutes <= 240)) e.push("predeploy.emergency.maxMinutes: 1..240");
    }
  }

  const ls = p.liveScan;
  if (ls !== undefined) {
    if (!isObj(ls)) e.push("predeploy.liveScan: must be an object");
    else {
      const lk = ["enabled", "image", "targets", "callOriginationExcludes", "noCallOriginationRoutes", "extraExcludes", "guards", "requireAfterDeploy", "maxDurationMin", "threads", "userAgent", "minSeverity"];
      for (const k of Object.keys(ls)) if (!lk.includes(k)) e.push(`predeploy.liveScan.${k}: unknown key`);
      if (ls.enabled !== false) {
        if (!Array.isArray(ls.targets) || !ls.targets.length) e.push("predeploy.liveScan.targets: required non-empty array");
        else {
          const tids = new Set();
          ls.targets.forEach((t, i) => {
            const at = `predeploy.liveScan.targets[${i}]`;
            if (!isObj(t)) return e.push(`${at}: object`);
            for (const k of Object.keys(t)) if (!["id", "url", "openapi", "excludeRegexes", "headers"].includes(k)) e.push(`${at}.${k}: unknown key`);
            if (!isStr(t.id) || !/^[a-z0-9][a-z0-9-]*$/.test(t.id)) e.push(`${at}.id: kebab-case`); else if (tids.has(t.id)) e.push(`${at}.id: duplicate`); else tids.add(t.id);
            if (!/^https?:\/\/[^\s/]+/.test(String(t.url))) e.push(`${at}.url: http(s) URL`);
            for (const rx of t.excludeRegexes || []) try { new RegExp(rx); } catch (x) { e.push(`${at}.excludeRegexes: ${x.message}`); }
            (t.headers || []).forEach((h, j) => {
              if (!isObj(h) || !isStr(h.name) || !isStr(h.credentialRef) || Object.keys(h).length !== 2) e.push(`${at}.headers[${j}]: only { name, credentialRef } — secrets are never inlined`);
              else if (/customer|tenant-?user|agent-?login|prod-?user|password/i.test(h.credentialRef)) e.push(`${at}.headers[${j}].credentialRef: "${h.credentialRef}" looks like a real customer credential — the live scan may only use scan/service tokens`);
            });
          });
        }
        const co = ls.callOriginationExcludes;
        if (!Array.isArray(co)) e.push("predeploy.liveScan.callOriginationExcludes: required array of URL-path regexes that can place PSTN calls");
        else if (!co.length && ls.noCallOriginationRoutes !== true) e.push("predeploy.liveScan.callOriginationExcludes: empty — list the routes that originate calls, or set noCallOriginationRoutes: true to state there are none");
        else for (const rx of co) try { new RegExp(rx); } catch (x) { e.push(`predeploy.liveScan.callOriginationExcludes: ${x.message}`); }
        const gd = ls.guards;
        if (!isObj(gd) || gd.noRealCustomerCredentials !== true || gd.noPstnCalls !== true) e.push("predeploy.liveScan.guards: { noRealCustomerCredentials: true, noPstnCalls: true } must be stated — they are the only two limits on the active scan");
      }
    }
  }
  return e;
}
