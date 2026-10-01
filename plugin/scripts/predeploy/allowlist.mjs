/**
 * allowlist.mjs — the ONLY way a finding may pass the pre-deploy gate.
 *
 * File (default `predeploy-allowlist.json`, committed + reviewed):
 *   { "version": 1, "entries": [
 *     { "check": "semgrep", "id": "rule.id", "location": "src/foo.ts" (optional substring),
 *       "reason": "why this is a false positive / accepted, >= 12 chars",
 *       "owner": "who answers for it", "expires": "YYYY-MM-DD" } ] }
 *
 * Enforced mechanically:
 *  - expired entry            -> `allowlist-expired` finding (gate fails)
 *  - expiry beyond maxDays    -> `allowlist-too-long`  (no indefinite exceptions; default 90 days)
 *  - missing reason/owner     -> `allowlist-invalid`
 *  - entry matching nothing in a check that ran -> `allowlist-unused` (clean the list as you fix things)
 *  - allowlist file modified or untracked vs HEAD -> `allowlist-uncommitted` (it must be reviewed in git)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, isoDate, sha256 } from "./lib.mjs";

export function loadAllowlist(root, relPath) {
  const abs = join(root, relPath);
  if (!existsSync(abs)) return { path: relPath, entries: [], raw: "", present: false, problems: [] };
  const raw = readFileSync(abs, "utf8");
  const problems = [];
  let entries = [];
  try {
    const j = JSON.parse(raw);
    if (!j || j.version !== 1 || !Array.isArray(j.entries)) problems.push("must be { version: 1, entries: [...] }");
    else entries = j.entries;
  } catch (e) {
    problems.push("not valid JSON: " + e.message);
  }
  return { path: relPath, entries, raw, present: true, problems };
}

export function allowlistHash(al) {
  return sha256(al.raw || "");
}

/** Static validation of entries against the configured check ids. */
export function validateEntries(al, { checkIds, maxDays = 90, today = new Date() }) {
  const findings = [];
  const bad = (id, message, i) => findings.push({ check: "allowlist", id, severity: "high", message, location: `${al.path}#${i}` });
  for (const p of al.problems) findings.push({ check: "allowlist", id: "allowlist-invalid", severity: "high", message: p, location: al.path });
  const horizon = new Date(today.getTime() + maxDays * 86400000);
  al.entries.forEach((e, i) => {
    if (!e || typeof e !== "object") return bad("allowlist-invalid", "entry is not an object", i);
    if (!checkIds.includes(e.check)) bad("allowlist-invalid", `entry.check "${e.check}" is not a configured check`, i);
    if (typeof e.id !== "string" || !e.id.trim()) bad("allowlist-invalid", "entry.id is required", i);
    if (typeof e.reason !== "string" || e.reason.trim().length < 12) bad("allowlist-invalid", "entry.reason must explain the exception (>= 12 chars)", i);
    if (typeof e.owner !== "string" || !e.owner.trim()) bad("allowlist-invalid", "entry.owner is required", i);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.expires))) return bad("allowlist-invalid", "entry.expires must be YYYY-MM-DD", i);
    const exp = new Date(e.expires + "T23:59:59Z");
    if (exp < today) bad("allowlist-expired", `expired ${e.expires}: ${e.check}/${e.id} — fix the finding or renew with a fresh review`, i);
    else if (exp > horizon) bad("allowlist-too-long", `expires ${e.expires}, beyond the ${maxDays}-day maximum (latest allowed ${isoDate(horizon)})`, i);
  });
  return findings;
}

/** The allowlist must be committed and unmodified so that every exception was reviewed in git. */
export function allowlistCommitted(root, al) {
  if (!al.present) return true;
  const tracked = git(root, ["ls-files", "--error-unmatch", al.path]) !== null;
  if (!tracked) return false;
  const dirty = git(root, ["status", "--porcelain", "--", al.path]);
  return dirty === "";
}

function matches(e, f) {
  if (e.check !== f.check || e.id !== f.id) return false;
  return !e.location || String(f.location || "").includes(e.location);
}

/**
 * Splits findings into blocking vs allowlisted. Only non-expired, valid entries
 * can except anything. `ranChecks` limits unused-entry detection to checks that
 * actually executed in this invocation.
 */
export function applyAllowlist(findings, al, { today = new Date(), ranChecks }) {
  const live = al.entries.filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(String(e.expires)) && new Date(e.expires + "T23:59:59Z") >= today && e.reason && e.owner);
  const used = new Set();
  const blocking = [];
  const allowed = [];
  for (const f of findings) {
    const hit = live.find((e) => matches(e, f));
    if (hit) { used.add(hit); allowed.push({ ...f, allowlist: { reason: hit.reason, owner: hit.owner, expires: hit.expires } }); }
    else blocking.push(f);
  }
  const unused = live.filter((e) => ranChecks.includes(e.check) && !used.has(e)).map((e) => ({ check: "allowlist", id: "allowlist-unused", severity: "medium", message: `entry ${e.check}/${e.id} matches no finding — remove it`, location: al.path }));
  return { blocking, allowed, unused };
}
