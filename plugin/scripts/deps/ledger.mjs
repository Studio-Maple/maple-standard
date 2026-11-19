/**
 * ledger.mjs - deps-ledger.json (D086): the committed, per-project note that justifies every NEW DIRECT dependency.
 *
 *   { "version": 1, "entries": { "<name>": { "why": "...", "existing": "...", "alternative": "...", "dev": false } } }
 *
 * Runtime dependencies need why + existing + alternative; dev-only ones need only why. Each field is >= 15 chars and
 * not placeholder text. Pure helpers + one file read; no network.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LEDGER_FILE = "deps-ledger.json";
export const MIN_FIELD = 15;
export const RUNTIME_FIELDS = ["why", "existing", "alternative"];
export const DEV_FIELDS = ["why"];

const PLACEHOLDER = /^(?:todo|tbd|tba|n\/?a|none|nothing|null|undefined|fixme|xxx+|placeholder|lorem(?:\s+ipsum)?|\.{2,}|…+|-+|_+|\?+|same|see above|as above|because|needed)\b[\s\W]*$/i;
const PLACEHOLDER_START = /^(?:todo|tbd|fixme|lorem|placeholder)\b/i;

/** True when `text` is empty, too short, or filler. */
export function isWeak(text) {
  if (typeof text !== "string") return true;
  const t = text.trim();
  if (t.length < MIN_FIELD) return true;
  if (PLACEHOLDER.test(t) || PLACEHOLDER_START.test(t)) return true;
  return new Set(t.toLowerCase().replace(/\W/g, "")).size < 6; // "aaaaaaaaaaaaaaaaaa", "...................."
}

const norm = (n) => n.toLowerCase().replace(/[-_.]+/g, "-");
export const ledgerKeys = (name) => [...new Set([name, name.toLowerCase(), norm(name)])];

/** @returns {{ entries: Record<string, object>, problem: string|null, exists: boolean }} */
export function loadLedger(root) {
  const file = join(root || ".", LEDGER_FILE);
  if (!existsSync(file)) return { entries: {}, problem: null, exists: false };
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    if (!j || typeof j !== "object" || j.version !== 1 || !j.entries || typeof j.entries !== "object" || Array.isArray(j.entries)) {
      return { entries: {}, problem: `${LEDGER_FILE} must look like { "version": 1, "entries": { ... } }`, exists: true };
    }
    return { entries: j.entries, problem: null, exists: true };
  } catch (err) {
    return { entries: {}, problem: `${LEDGER_FILE} is not valid JSON (${err instanceof Error ? err.message : err})`, exists: true };
  }
}

export function findEntry(entries, name) {
  for (const k of ledgerKeys(name)) if (entries[k] && typeof entries[k] === "object") return entries[k];
  return null;
}

/** What is wrong with a package's ledger entry for an add (dev-only or runtime). [] = complete. */
export function entryProblems(entry, dev) {
  if (!entry) return ["no entry"];
  return (dev ? DEV_FIELDS : RUNTIME_FIELDS)
    .filter((f) => isWeak(entry[f]))
    .map((f) => (typeof entry[f] === "string" && entry[f].trim() ? `"${f}" is too short or placeholder text` : `"${f}" is missing`));
}

/** Entries whose package is in no manifest any more. */
export function staleEntries(entries, allNames) {
  const have = new Set([...allNames].map(norm));
  return Object.keys(entries).filter((k) => !have.has(norm(k)));
}
