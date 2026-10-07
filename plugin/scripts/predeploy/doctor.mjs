#!/usr/bin/env node
/**
 * doctor.mjs — `predeploy doctor`: which tools/images/credentials the
 * configured gate needs, which are missing, and the exact install command.
 *
 *   node doctor.mjs [--root DIR] [--pull] [--json]
 *
 * --pull downloads missing Docker images (official publishers only) so the
 * gate can run. Exit 0 = everything the gate needs is runnable, 1 = gaps.
 */
import { credentialExists } from "./credentials.mjs";
import { PRESETS } from "./catalog.mjs";
import { normalize, validatePredeploy } from "./config.mjs";
import { findProjectRoot, loadMapleConfig, which } from "./lib.mjs";
import { GB, diskLines, diskReport, lowSpaceMessage } from "./runs.mjs";
import { TOOLS, dockerUsable, installHints, resolveTool } from "./tools.mjs";

const argv = process.argv.slice(2);
const pull = argv.includes("--pull");
const json = argv.includes("--json");
const root = findProjectRoot(argv.includes("--root") ? argv[argv.indexOf("--root") + 1] : process.cwd());
const cfg = root && loadMapleConfig(root);
const problems = cfg ? validatePredeploy(cfg) : ["no maple.config.json"];
const pd = cfg && normalize(cfg);
const rows = [];
const need = new Map();
const creds = new Set();
for (const c of pd?.checks || []) {
  const tools = c.github ? ["gh"] : c.preset ? PRESETS[c.preset]?.tools || [] : c.tools || [];
  for (const t of tools) need.set(t, [...(need.get(t) || []), c.id]);
  if (c.preset && PRESETS[c.preset]?.credentials) for (const r of PRESETS[c.preset].credentials(c.options || {})) creds.add(r);
  for (const r of c.credentials || []) creds.add(r);
}
if (pd?.liveScan && pd.liveScan.enabled !== false) {
  need.set("zap", ["live-scan"]);
  need.set("docker", [...(need.get("docker") || []), "live-scan"]);
  for (const t of pd.liveScan.targets || []) for (const h of t.headers || []) creds.add(h.credentialRef);
}
for (const [name, users] of need) {
  if (!TOOLS[name]) { rows.push({ tool: name, mode: "unknown", users, install: "" }); continue; }
  const r = resolveTool(name, { allowDocker: pd?.docker?.enabled !== false, pull });
  rows.push({ tool: name, mode: r.mode, detail: r.version || r.image || r.reason, users, install: r.mode === "missing" ? installHints(name) : "", note: TOOLS[name].note });
}
const credRows = [...creds].map((c) => ({ credential: c, present: credentialExists(c) }));
const disk = root ? diskReport(root, pd) : null;
const lowSpace = disk ? lowSpaceMessage(disk, "node <plugin>/scripts/predeploy/run.mjs prune --all") : null;
const gaps = rows.filter((r) => r.mode === "missing" || r.mode === "unknown").length + credRows.filter((c) => !c.present).length + problems.length + (lowSpace ? 1 : 0);
if (json) console.log(JSON.stringify({ problems, rows, credRows, docker: dockerUsable(), disk: disk && { ...disk, runsGB: disk.runsBytes / GB, tfCacheGB: disk.tfCacheBytes / GB, freeGB: disk.freeBytes === null ? null : disk.freeBytes / GB }, gaps }, null, 2));
else {
  console.log(`predeploy doctor — docker: ${dockerUsable().ok ? "running " + dockerUsable().detail : "NOT RUNNING"}  git: ${which("git") ? "ok" : "MISSING"}`);
  for (const p of problems) console.log(`  CONFIG  ${p}`);
  for (const r of rows) {
    console.log(`  ${r.mode === "missing" || r.mode === "unknown" ? "MISSING" : "ok     "} ${r.tool.padEnd(12)} ${r.mode}${r.detail ? " (" + r.detail + ")" : ""}  <- ${r.users.join(", ")}`);
    if (r.install) console.log(`            install: ${r.install}`);
    if (r.note && r.mode !== "native") console.log(`            note: ${r.note}`);
  }
  for (const c of credRows) console.log(`  ${c.present ? "ok     " : "MISSING"} credential ${c.credential}${c.present ? "" : "  (store via the credential-manager skill; name only, never paste the value)"}`);
  if (disk) for (const l of diskLines(disk)) console.log(`  ${l}`);
  if (lowSpace) console.log(`  LOW SPACE ${lowSpace}`);
  console.log(gaps ? `\n${gaps} gap(s). The gate fails (tool-missing) rather than skipping a scanner.` : "\nall tooling present.");
}
process.exit(gaps ? 1 : 0);
