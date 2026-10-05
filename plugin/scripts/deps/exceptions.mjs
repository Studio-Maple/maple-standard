/**
 * exceptions.mjs — decision-backed dependency-freshness exceptions (D064), the same pattern as the
 * pre-deploy gate's decision-backed exceptions (D061): an exception exists only while a recorded
 * decision requires the old version, so every entry must cite a D### that is in the decisions ledger.
 *
 *   maple.config.json:
 *     "deps": { "exceptions": [
 *       { "name": "eslint", "range": "^9.39.0", "decision": "D070", "why": "eslint-config-next 16 does not support 10 yet" } ] }
 *
 * `range` (optional) scopes the exception to one freshness bucket (same major; for 0.x same minor) —
 * `^9.39.0` also covers `eslint@9` — so a bump to a different old major is not silently waved through.
 * Omitted, it covers any version of the package. An entry that cites a missing D### is INVALID: it
 * excepts nothing and is reported as a problem.
 */
import { existsSync, readFileSync } from "node:fs";
import { loadMapleConfig, resolveDocsConfig } from "../docs/lib/config.mjs";
import { sameBucket } from "./semver-lite.mjs";

const WHY_MIN = 10;

/** True when the decisions ledger has a `## D###` heading for the id. */
export function ledgerHasDecision(ledgerText, id) {
  return new RegExp(`^#{1,6}\\s+${id}\\b`, "m").test(ledgerText);
}

/**
 * Validate raw exception entries against a ledger text (null = ledger unreadable).
 * @returns {{ valid: object[], problems: string[] }}
 */
export function validateExceptions(entries, ledgerText) {
  const valid = [];
  const problems = [];
  if (entries === undefined) return { valid, problems };
  if (!Array.isArray(entries)) return { valid, problems: ["deps.exceptions must be an array"] };
  entries.forEach((e, i) => {
    const at = `deps.exceptions[${i}]${e && typeof e.name === "string" ? ` (${e.name})` : ""}`;
    const bad = [];
    if (!e || typeof e !== "object") bad.push("not an object");
    else {
      if (typeof e.name !== "string" || !e.name.trim()) bad.push("name is required");
      if (e.range !== undefined && typeof e.range !== "string") bad.push("range must be a string");
      if (typeof e.decision !== "string" || !/^D\d{3,}$/.test(e.decision)) bad.push("decision must be a D### id");
      if (typeof e.why !== "string" || e.why.trim().length < WHY_MIN) bad.push(`why is required (>= ${WHY_MIN} chars)`);
    }
    if (bad.length === 0 && ledgerText === null) bad.push("decisions ledger is unreadable, cannot verify " + e.decision);
    else if (bad.length === 0 && !ledgerHasDecision(ledgerText, e.decision)) bad.push(`${e.decision} is not in the decisions ledger`);
    if (bad.length) problems.push(`${at}: ${bad.join("; ")}`);
    else valid.push(e);
  });
  return { valid, problems };
}

/** Load + validate `deps.exceptions` for a project root (config + ledger resolved the way the docs tooling does). */
export function loadExceptions(root) {
  const entries = loadMapleConfig(root)?.deps?.exceptions;
  if (entries === undefined) return { valid: [], problems: [] };
  const ledger = resolveDocsConfig(root).decisions;
  let text = null;
  try {
    if (existsSync(ledger)) text = readFileSync(ledger, "utf8");
  } catch {
    text = null;
  }
  return validateExceptions(entries, text);
}

/** The valid exception covering `name@range`, if any. `names` are the dependency key and the alias target. */
export function findException(valid, names, range) {
  return valid.find((e) => names.includes(e.name) && (e.range === undefined || e.range === range || sameBucket(e.range, range)));
}
