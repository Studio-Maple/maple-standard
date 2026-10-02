/**
 * decisions.mjs — decision-backed exceptions: the second, PERMANENT exception
 * list of the pre-deploy gate, next to the expiring allowlist (D061).
 *
 * ESSENTIALS ONLY. A finding belongs here only when it cannot be fixed because
 * a recorded decision requires the flagged state (a KMS key policy's root
 * statement, data-residency vs. replication, a carrier allow-listed public IP,
 * a scanner false positive). Anything fixable, deferrable or merely
 * inconvenient goes in the code or in the expiring allowlist, never here.
 *
 * File (default `predeploy-decisions.json`, committed + reviewed):
 *   { "version": 1, "entries": [
 *     { "scanner": "checkov",                       // a configured check id (or "live-scan")
 *       "rule": "CKV_AWS_109",                      // the finding id, exactly
 *       "scope": "infra/aws/kms.tf#aws_kms_key.rec",// exact file[#resource] — no wildcards
 *       "decision": "D160",                         // must exist in the project's decisions ledger
 *       "why": "why it cannot be fixed (20-600 chars)",
 *       "reviewed": "YYYY-MM-DD" } ] }
 *
 * Enforced mechanically (every one is a blocking finding, check "decisions"):
 *  - bad shape / wildcard scope / duplicate entry   -> `decision-invalid`
 *  - decision id not in the ledger (docs.decisions) -> `decision-missing`
 *  - ledger unreadable while entries exist          -> `decision-ledger-unreadable`
 *  - scope matches no finding of a check that ran   -> `decision-stale`
 *  - reviewed older than decisionsMaxAgeDays (180)  -> `decision-review-overdue`
 *  - file untracked or modified vs HEAD             -> `decision-uncommitted`
 *
 * There is no default expiry — the review date is the forcing function. An entry may carry an optional `expires`
 * (YYYY-MM-DD, within reviewed + decisionsMaxAgeDays) for a thing that has a known removal trigger (e.g. a rollback host
 * destroyed in a later phase): once past it the entry stops excepting anything and is a blocking `decision-expired` finding.
 *
 * RULE-WIDE SCOPE (the one sanctioned wildcard): `"scope": "*"` + `"maxSeverity": "<level>"`
 * covers EVERY finding of that exact scanner+rule up to that severity. It exists for advisory
 * noise that is a property of the rule, not of any resource (e.g. Supabase `unused_index` on
 * near-empty tables), where one entry per finding would be 60+ entries. It is bounded twice —
 * an exact rule id and a severity ceiling, so a worse finding of the same rule still blocks —
 * it still needs a D### and a review date, goes stale when it matches nothing, and the report
 * counts what it covers (never hidden).
 *
 * SCOPE grammar: `path` | `path#resource`. `path` is the finding location with
 * its `:line` stripped and compared by equality (so an entry survives line
 * drift); `resource` is the scanner's own resource id (checkov/trivy
 * `aws_kms_key.x`, osv `name@version`) compared by equality. A path-only
 * scope covers every finding of that rule in that one file, so prefer
 * `path#resource` wherever the scanner reports a resource. Non-file locations
 * (a repo, a URL) are matched by exact string equality.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SEVERITIES, git, isoDate, sevRank, sha256 } from "./lib.mjs";
import { resolveDocsConfig } from "../docs/lib/config.mjs";

export const DECISIONS_DEFAULT_PATH = "predeploy-decisions.json";
export const DECISIONS_MAX_AGE_DEFAULT = 180;
export const WHY_MIN = 20;
export const WHY_MAX = 600;
export const ESSENTIALS_RULE = "ESSENTIALS ONLY: a decision-backed exception stays only while it cannot be fixed; it is permanent, so it must be re-reviewed (max age enforced) — if it can be fixed, fix it";

const DAY = 86400000;
const WILDCARD = /[*?]|(^|\/)\.\.(\/|$)/;

export function loadDecisions(root, relPath) {
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

export const decisionsHash = (dl) => sha256(dl.raw || "");

/**
 * Ids a ledger DEFINES (not merely mentions): `## D12 | ...` headings and
 * `- **D12 — ...` / `**D12 ...` bullets (the two shapes the ledgers use).
 */
export function decisionIdsIn(text) {
  const ids = new Set();
  for (const m of String(text).matchAll(/^\s*(?:#{1,6}\s+|[-*]\s+\*\*|\*\*)(D\d+)\b/gm)) ids.add(m[1]);
  return ids;
}

/** Decision ids defined in the project's decisions ledger (docs.decisions). */
export function ledgerDecisionIds(root) {
  let file;
  try { file = resolveDocsConfig(root).decisions; } catch (e) { return { ids: new Set(), file: "", error: e.message }; }
  if (!existsSync(file)) return { ids: new Set(), file, error: "decisions ledger not found" };
  const ids = new Set();
  for (const id of decisionIdsIn(readFileSync(file, "utf8"))) ids.add(id);
  return { ids, file, error: null };
}

const stripLine = (loc) => String(loc || "").replace(/:\d+(-\d+)?$/, "").replace(/^\/+/, "");

/** Split a scope into its exact parts. */
export function parseScope(scope) {
  const s = String(scope);
  const i = s.indexOf("#");
  return i < 0 ? { file: s.replace(/^\/+/, ""), resource: undefined } : { file: s.slice(0, i).replace(/^\/+/, ""), resource: s.slice(i + 1) };
}

export function entryMatches(e, f) {
  if (e.scanner !== f.check || e.rule !== f.id) return false;
  if (e.scope === "*") return SEVERITIES.includes(e.maxSeverity) && sevRank(f.severity) <= sevRank(e.maxSeverity);
  const { file, resource } = parseScope(e.scope);
  const locOk = stripLine(f.location) === file || String(f.location || "") === e.scope;
  return resource === undefined ? locOk : locOk && f.resource === resource;
}

const F = (id, message, location, severity = "high") => ({ check: "decisions", id, severity, message, location });

/** Static validation + ledger + review age. `ledger` is the result of ledgerDecisionIds(). */
export function validateDecisions(dl, { checkIds, maxAgeDays = DECISIONS_MAX_AGE_DEFAULT, today = new Date(), ledger }) {
  const findings = dl.problems.map((p) => F("decision-invalid", p, dl.path));
  const seen = new Set();
  let ledgerReported = false;
  dl.entries.forEach((e, i) => {
    const at = `${dl.path}#entries[${i}]`;
    const bad = (m) => findings.push(F("decision-invalid", `entry ${i}: ${m}`, dl.path));
    if (!e || typeof e !== "object" || Array.isArray(e)) return bad("not an object");
    for (const k of Object.keys(e)) if (!["scanner", "rule", "scope", "decision", "why", "reviewed", "maxSeverity", "expires"].includes(k)) bad(`unknown key "${k}"`);
    const ruleWide = e.scope === "*";
    if (ruleWide && !SEVERITIES.includes(e.maxSeverity)) bad(`scope "*" (rule-wide) needs maxSeverity, one of ${SEVERITIES.join("|")}`);
    if (!ruleWide && e.maxSeverity !== undefined) bad("maxSeverity is only valid with scope \"*\"");
    if (!checkIds.includes(e.scanner)) bad(`scanner "${e.scanner}" is not a configured check`);
    if (typeof e.rule !== "string" || !e.rule.trim()) bad("rule is required (the exact finding id)");
    if (typeof e.scope !== "string" || !e.scope.trim()) bad("scope is required (exact `path` or `path#resource`)");
    else if (!ruleWide && (WILDCARD.test(e.scope) || /\/$/.test(e.scope.split("#")[0]) || e.scope.split("#")[0] === "" || e.scope.split("#").length > 2 || e.scope.endsWith("#"))) bad(`scope "${e.scope}" must be one exact file or file#resource — no wildcards, directories or relative escapes`);
    if (typeof e.decision !== "string" || !/^D\d+$/.test(e.decision)) bad("decision must be a decision id like D123");
    if (typeof e.why !== "string" || e.why.trim().length < WHY_MIN || e.why.length > WHY_MAX) bad(`why must say why it cannot be fixed (${WHY_MIN}-${WHY_MAX} chars)`);
    const key = [e.scanner, e.rule, e.scope].join("\u0000");
    if (seen.has(key)) bad(`duplicate of an earlier entry (${e.scanner}/${e.rule}/${e.scope})`); else seen.add(key);

    if (/^D\d+$/.test(String(e.decision))) {
      if (ledger.error) {
        if (!ledgerReported) { findings.push(F("decision-ledger-unreadable", `cannot validate decision ids: ${ledger.error} (${ledger.file || "docs.decisions"})`, dl.path)); ledgerReported = true; }
      } else if (!ledger.ids.has(e.decision)) findings.push(F("decision-missing", `${e.decision} is not in the decisions ledger (${ledger.file}) — record the decision first (${e.scanner}/${e.rule} ${e.scope})`, at));
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.reviewed))) return bad("reviewed must be YYYY-MM-DD");
    const rev = new Date(e.reviewed + "T00:00:00Z");
    if (Number.isNaN(rev.getTime())) return bad("reviewed is not a real date");
    if (rev.getTime() > today.getTime() + DAY) return bad("reviewed is in the future");
    if (e.expires !== undefined) {
      const ex = /^\d{4}-\d{2}-\d{2}$/.test(String(e.expires)) ? new Date(e.expires + "T00:00:00Z") : null;
      if (!ex || Number.isNaN(ex.getTime())) bad("expires must be a real YYYY-MM-DD date");
      else if (ex.getTime() < rev.getTime()) bad("expires is before reviewed");
      else if (ex.getTime() > rev.getTime() + maxAgeDays * DAY) bad(`expires ${e.expires} is more than ${maxAgeDays} days after reviewed ${e.reviewed}`);
      else if (isoDate(today) > e.expires) findings.push(F("decision-expired", `entry ${e.scanner}/${e.rule} ${e.scope} (${e.decision}) expired ${e.expires} — its removal trigger has passed; remove the entry (the finding blocks again)`, at));
    }
    const age = Math.floor((today.getTime() - rev.getTime()) / DAY);
    if (age > maxAgeDays) findings.push(F("decision-review-overdue", `reviewed ${e.reviewed} (${age} days ago, max ${maxAgeDays}) — re-review: is ${e.scanner}/${e.rule} ${e.scope} STILL unfixable? fix it or bump \`reviewed\` (latest allowed ${isoDate(new Date(today.getTime() - maxAgeDays * DAY))} or newer)`, at));
  });
  return findings;
}

/** Must be committed + unmodified so every permanent exception was reviewed in git. */
export function decisionsCommitted(root, dl) {
  if (!dl.present) return true;
  if (git(root, ["ls-files", "--error-unmatch", dl.path]) === null) return false;
  return git(root, ["status", "--porcelain", "--", dl.path]) === "";
}

/**
 * Splits findings into still-blocking vs decision-backed. Only entries that pass
 * shape validation can except anything. `ranChecks` limits stale detection to
 * checks that executed in this invocation.
 */
const expiredEntry = (e, today) => typeof e.expires === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.expires) && isoDate(today) > e.expires;

export function applyDecisions(findings, dl, { ranChecks = [], today = new Date() } = {}) {
  const usable = dl.entries.filter((e) => e && typeof e === "object" && !expiredEntry(e, today) && typeof e.scope === "string" && e.scope.trim() && (e.scope === "*" ? SEVERITIES.includes(e.maxSeverity) : !WILDCARD.test(e.scope)) && typeof e.rule === "string" && typeof e.scanner === "string");
  const used = new Set();
  const blocking = [];
  const backed = [];
  for (const f of findings) {
    const hit = usable.find((e) => entryMatches(e, f));
    if (hit) { used.add(hit); backed.push({ ...f, decisionBacked: { decision: hit.decision, why: hit.why, reviewed: hit.reviewed, scope: hit.scope, maxSeverity: hit.maxSeverity, expires: hit.expires } }); }
    else blocking.push(f);
  }
  const stale = usable.filter((e) => ranChecks.includes(e.scanner) && !used.has(e))
    .map((e) => F("decision-stale", `entry ${e.scanner}/${e.rule} ${e.scope} (${e.decision}) matches no finding — the thing was fixed or moved; remove the entry`, dl.path));
  return { blocking, backed, stale };
}

/** Separate, prominent report block — never folded into a "0 findings" line. */
export function summarizeDecisions(backed, dl, maxAgeDays = DECISIONS_MAX_AGE_DEFAULT) {
  const lines = [];
  const byDecision = new Map();
  for (const f of backed) byDecision.set(f.decisionBacked.decision, (byDecision.get(f.decisionBacked.decision) || 0) + 1);
  if (backed.length || dl.entries.length) {
    const spread = [...byDecision].sort().map(([d, n]) => `${d}:${n}`).join(" ");
    lines.push(`*** ${backed.length} DECISION-BACKED EXCEPTION${backed.length === 1 ? "" : "S"} (${dl.entries.length} permanent entr${dl.entries.length === 1 ? "y" : "ies"} in ${dl.path}${spread ? "; " + spread : ""}) — NOT ZERO; reviewed every ${maxAgeDays}d ***`);
    lines.push(`    rule: ${ESSENTIALS_RULE}`);
  }
  return { total: backed.length, entries: dl.entries.length, rule: ESSENTIALS_RULE, maxAgeDays, byDecision: Object.fromEntries(byDecision), lines };
}
