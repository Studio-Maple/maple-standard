/**
 * ledger-gate.mjs - the ci:fast half of the dependency-necessity control (D086).
 *
 * Every direct dependency ADDED since the target branch (in any package.json / pyproject.toml / requirements*.txt,
 * committed or not) must have a complete entry in deps-ledger.json, so a hand-edited manifest cannot skip the
 * hook. Runs in the control's own mode (D082): "enforce" fails the gate, "warn" prints a warning instead, "off"
 * skips. Ledger entries for packages no manifest declares any more are always a warning (a removed dependency
 * should drop its entry). No network.
 */
import { loadMapleConfig } from "../docs/lib/config.mjs";
import { controlMode } from "../../hooks/guards/security-mode.mjs";
import { entryProblems, findEntry, loadLedger, LEDGER_FILE, staleEntries } from "./ledger.mjs";
import { inSkippedDir, isManifestName, parseManifest, projectDeps, scanManifests } from "./manifests.mjs";

function baseDeps(root, base, git) {
  let listed;
  try { listed = git(root, ["ls-tree", "-r", "--name-only", base]); } catch { return null; }
  const manifests = [];
  for (const file of listed.split(/\r?\n/).filter((f) => f && isManifestName(f.split("/").pop()) && !inSkippedDir(f))) {
    try {
      const m = parseManifest(file, git(root, ["show", `${base}:./${file}`]));
      if (m) manifests.push({ file, ...m });
    } catch { /* file absent at base */ }
  }
  return projectDeps(root, manifests);
}

/** @returns {{ errors: number, lines: string[] }} */
export function ledgerGate({ root, base, git, now }) {
  const mode = controlMode(loadMapleConfig(root), "necessity", now);
  if (mode === "off") return { errors: 0, lines: [] };
  const lines = [];
  let errors = 0;
  const report = (msg) => {
    if (mode === "enforce") { errors += 1; lines.push(`[error] ${msg}`); } else lines.push(`[warn] ${msg} (necessity is in warn mode, D082)`);
  };

  const now_ = projectDeps(root, scanManifests(root));
  const before = baseDeps(root, base, git);
  const ledger = loadLedger(root);
  if (ledger.problem) report(`necessity: ${ledger.problem}`);
  else if (before === null) lines.push("[warn] necessity: cannot list manifests at the base commit, skipped");
  else {
    let added = 0;
    let missing = 0;
    for (const eco of ["npm", "PyPI"]) {
      for (const name of [...now_[eco].all].sort()) {
        if (before[eco].all.has(name)) continue;
        added += 1;
        const dev = now_[eco].dev.has(name) && !now_[eco].runtime.has(name);
        const problems = entryProblems(findEntry(ledger.entries, name), dev);
        if (problems.length) missing += 1;
        if (problems.length) report(`necessity (D086): new direct dependency ${name}${dev ? " (dev)" : ""} has no complete ${LEDGER_FILE} entry: ${problems.join("; ")}. Entry shape: { "why", "existing", "alternative" } (dev-only: "why"), each >= 15 chars.`);
      }
    }
    lines.push(`necessity: ${added} new direct dependenc${added === 1 ? "y" : "ies"} vs base, ${missing} without a complete ${LEDGER_FILE} entry.`);
  }
  const stale = staleEntries(ledger.entries, new Set([...now_.npm.all, ...now_.PyPI.all]));
  for (const name of stale) lines.push(`[warn] ${LEDGER_FILE}: entry "${name}" is for a package no manifest declares any more; remove it.`);
  return { errors, lines };
}
