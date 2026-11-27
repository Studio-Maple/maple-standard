#!/usr/bin/env node
/**
 * fastlane-cli.mjs - the fast lane's three commands (fastlane.mjs holds the rules).
 *
 *   node fastlane-cli.mjs check   [--target T] [--root DIR] [--json]   would HEAD qualify? (no secret scan, writes nothing)
 *   node fastlane-cli.mjs permit  [--target T] [--owner-approved "<owner's words>"] [--root DIR] [--json]
 *                                                         run every pre-deploy condition; on success issue the permit
 *   node fastlane-cli.mjs status  [--root DIR] [--json]   every open debt (one per target), its deadline and what pays it
 *
 * --target is required when the project configures predeploy.fastLane.targets (a target whose mode is owner-only also needs
 * --owner-approved, recorded in the permit); without `targets` it is ignored.
 *
 * Exit codes: check/permit 0 = eligible / permit issued, 1 = refused (each reason printed).
 *             status 0 = no debt, 10 = debt owed, 11 = debt OVERDUE. A scheduled runner polls `status --json` and, on
 *             10/11, runs `action.run` (heavy + predeploy) on `action.on`.
 */
import { permit, status } from "./fastlane.mjs";
import { findProjectRoot } from "./lib.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];
const json = argv.includes("--json");
const rootArg = argv.includes("--root") ? argv[argv.indexOf("--root") + 1] : null;
const root = findProjectRoot(rootArg || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const short = (s) => String(s || "").slice(0, 8);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const target = opt("--target");
const ownerApproved = opt("--owner-approved");

if (!root) { console.error("no maple.config.json found"); process.exit(2); }

if (cmd === "check" || cmd === "permit") {
  const deps = cmd === "check" ? { secretScan: () => ({ ok: true }) } : {};
  let r;
  try { r = permit(root, { write: cmd === "permit", deps, target, ownerApproved }); } catch (e) { r = { ok: false, failures: ["fast-lane error: " + e.message], denied: [] }; }
  if (json) console.log(JSON.stringify(r));
  else if (r.ok) {
    console.log(cmd === "permit"
      ? `FAST-LANE PERMIT ISSUED for ${short(r.sha)}: ${r.files} eligible path(s) since ${short(r.base)}; valid until ${r.permit.expiresAt}.\n` +
        `Deploying under it records a debt: a green heavy run AND a predeploy stamp are then OWED on ${short(r.sha)} within ${r.permit.deadlineHours}h, and no other deploy${r.target ? " to " + r.target : ""} is allowed until they exist.`
      : `ELIGIBLE: ${r.files} changed path(s) since ${short(r.base)} may take the fast lane (secret scan not run by \`check\`; \`permit\` runs it).`);
  } else {
    console.log(`FAST LANE REFUSED${r.sha ? " for " + short(r.sha) : ""} - take the full path (heavy + predeploy stamps on this commit):`);
    for (const f of r.failures) console.log("  - " + f);
    for (const d of r.denied) console.log(`      ${d.path}: ${d.reason}`);
  }
  process.exit(r.ok ? 0 : 1);
}

if (cmd === "status") {
  let s;
  try { s = status(root); } catch (e) { console.error("fast-lane error: " + e.message); process.exit(2); }
  if (json) console.log(JSON.stringify(s));
  else if (!s.debt) {
    console.log(`fast lane: ${s.enabled ? "enabled" : "not enabled"}${s.targets ? " (" + Object.entries(s.targets).map(([t, m]) => t + ": " + m).join(", ") + ")" : ""}; no debt open.` + (s.permit ? ` Permit outstanding for ${short(s.permit.sha)} until ${s.permit.expiresAt}.` : ""));
  } else {
    const d = s.debt;
    const left = d.overdue ? `OVERDUE by ${Math.round(-d.minutesLeft / 60 * 10) / 10}h` : `${Math.round(d.minutesLeft / 60 * 10) / 10}h left`;
    if (d.overdue) console.log("!!! FAST-LANE DEBT OVERDUE - production is running a commit that never got its full verification !!!");
    if (s.targets) console.log("targets: " + Object.entries(s.targets).map(([t, m]) => t + ": " + m).join(", "));
    for (const x of s.debts.filter((y) => y.sha !== d.sha || y.target !== d.target)) console.log(`also open: debt on ${x.sha}${x.target ? " [" + x.target + "]" : ""}, owes ${x.owes.join(" + ")}, ${x.overdue ? "OVERDUE" : "due " + x.deadline}`);
    console.log(`fast-lane debt on ${d.sha}${d.target ? " [target " + d.target + "]" : ""}`);
    console.log(`  deployed ${d.at}; deadline ${d.deadline} (${left})`);
    console.log(`  still owes: ${d.owes.join(" + ")}`);
    console.log(`  pays it: a green heavy run AND a predeploy stamp on ${short(d.sha)} or any commit that contains it`);
    console.log(`  or roll back: check out ${short(d.base)} (last fully stamped commit) and deploy it`);
    console.log(s.targets ? "  until then every other deploy to that target is refused (other targets are unaffected)." : "  until then every other production deploy is refused.");
  }
  process.exit(s.debt ? (s.debt.overdue ? 11 : 10) : 0);
}

console.error("usage: fastlane-cli.mjs check|permit|status [--target T] [--owner-approved TEXT] [--root DIR] [--json]");
process.exit(2);
