/**
 * add-guard.mjs - bash-guard's package-add + necessity check for an install command (D079-D082, D086).
 * Parses every package the command would add (add-cmd.mjs), then runs the two controls independently so each one
 * can honour its own warn/enforce mode (the caller applies the mode):
 *   packageAdd  release age, OSV, reputation (package-add.mjs)   - network, cached
 *   necessity   deps-ledger.json entry for a new direct dependency (necessity.mjs) - files only
 * Fail-open on any internal error is the caller's job; lookup failures here come back as warnings.
 */
import { parseAdds } from "./add-cmd.mjs";
import { checkNecessity } from "./necessity.mjs";
import { checkPackageAdds, formatFindings } from "./package-add.mjs";

/**
 * @param {string} command
 * @param {string} root project root
 * @param {{ packageAdd?: boolean, necessity?: boolean, options?: object, fetchImpl?: typeof fetch, now?: number,
 *           cacheDir?: string, budgetMs?: number, topDir?: string, capDir?: string }} [opts]
 * @returns {Promise<{ adds: object[], packageAdd: { deny: string|null, warnings: string[], rules: string[], names: string[] }, necessity: { deny: string|null, names: string[] } }>}
 */
export async function checkAdds(command, root, { packageAdd = true, necessity = true, capDir, ...rest } = {}) {
  const adds = parseAdds(command);
  const out = { adds, packageAdd: { deny: null, warnings: [], rules: [], names: [] }, necessity: { deny: null, names: [] } };
  if (adds.length === 0) return out;
  if (necessity) {
    const n = checkNecessity(adds, root, { capDir });
    out.necessity = { deny: n.message, names: n.missing };
  }
  if (packageAdd) {
    const r = await checkPackageAdds(adds, root, rest);
    out.packageAdd = { deny: formatFindings(r.findings), warnings: r.warnings, rules: [...new Set(r.findings.map((f) => f.rule))], names: [...new Set(r.findings.map((f) => f.pkg))] };
  }
  return out;
}
