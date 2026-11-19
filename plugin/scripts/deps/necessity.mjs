/**
 * necessity.mjs - the dependency-necessity check (control "necessity", D086). A package that becomes a NEW DIRECT
 * dependency (in no manifest of the project) needs a complete entry in the committed deps-ledger.json before the add.
 * Used by bash-guard (install commands) and dep-version-guard (package.json edits). Reads files only; no network.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_FILE, entryProblems, findEntry, loadLedger } from "./ledger.mjs";
import { projectDeps, scanManifests } from "./manifests.mjs";
import { describeOverlap, findOverlap } from "./overlap.mjs";

const LIST_MAX = 40;
const list = (set) => {
  const names = [...set].sort();
  return names.length ? `${names.slice(0, LIST_MAX).join(", ")}${names.length > LIST_MAX ? ` (+${names.length - LIST_MAX} more)` : ""}` : "(none)";
};

/**
 * @param {{eco: "npm"|"PyPI", name: string, dev: boolean, global?: boolean, manifest?: boolean}[]} adds
 * @returns {{ message: string|null, missing: string[] }}
 */
export function checkNecessity(adds, root, { capDir } = {}) {
  if (!root) return { message: null, missing: [] };
  const manifests = scanManifests(root);
  const known = projectDeps(root, manifests);
  const hasPy = manifests.some((m) => m.eco === "PyPI");
  const fresh = [...new Map(adds
    // an ad-hoc `pip install` in a repo with no Python manifest is not a project dependency
    .filter((a) => !a.global && (a.manifest !== false || a.eco !== "PyPI" || hasPy))
    .filter((a) => !known[a.eco].all.has(a.name.toLowerCase()))
    .map((a) => [`${a.eco}/${a.name}`, a])).values()];
  if (fresh.length === 0) return { message: null, missing: [] };

  const ledger = loadLedger(root);
  const bad = fresh
    .map((a) => ({ a, problems: ledger.problem ? [ledger.problem] : entryProblems(findEntry(ledger.entries, a.name), a.dev) }))
    .filter((x) => x.problems.length);
  if (bad.length === 0) return { message: null, missing: [] };

  const lines = [
    `necessity guard (D086): ${bad.map((x) => x.a.name).join(", ")} would become ${bad.length === 1 ? "a new direct dependency" : "new direct dependencies"} of this project, and ${LEDGER_FILE} (project root, committed) has no complete entry. ` +
      `Add one per package, then re-run the add (an ordinary Edit): { "version": 1, "entries": { "<name>": { "why": "what it does that we need", "existing": "which current dependency or platform/stdlib API you considered and why it does not fit", "alternative": "which more established or reliable package you considered", "dev": false } } }. ` +
      "Runtime dependencies need why + existing + alternative (each >= 15 characters, no placeholders); dev-only ones (-D / devDependencies / --group dev) need only why.",
    ...bad.map((x) => `  - ${x.a.name}${x.a.dev ? " (dev)" : ""}: ${x.problems.join("; ")}`),
  ];
  for (const eco of [...new Set(bad.map((x) => x.a.eco))]) {
    lines.push(`Existing direct ${eco === "npm" ? "npm" : "Python"} dependencies - runtime (${known[eco].runtime.size}): ${list(known[eco].runtime)}; dev (${known[eco].dev.size}): ${list(known[eco].dev)}.`);
  }
  for (const x of bad) lines.push(...describeOverlap(x.a.name, findOverlap(x.a.name, x.a.eco, known[x.a.eco].all, capDir)).map((l) => `Overlap: ${l}`));
  if (!existsSync(join(root, LEDGER_FILE)) && !ledger.problem) lines.push(`(${LEDGER_FILE} does not exist yet: create it.)`);
  return { message: lines.join("\n"), missing: bad.map((x) => x.a.name) };
}
