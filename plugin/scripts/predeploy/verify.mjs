#!/usr/bin/env node
/**
 * verify.mjs — "is there a valid predeploy stamp for HEAD?" For deploy
 * scripts (PowerShell/bash) and the guard hook. Exit 0 = yes, 1 = no.
 *
 *   node verify.mjs [--root DIR] [--quiet] [--json] [--check] [--target NAME]
 *
 * Also honours the fast lane (fastlane.mjs): a valid permit answers yes and records the fast-lane debt, unless
 * --check is given (look only). --target names the deploy target (default "production", the strictest): with
 * predeploy.fastLane.targets each target has its own mode, permit and debt.
 *
 * Fails CLOSED: any error reading state is a "no".
 */
import { findProjectRoot } from "./lib.mjs";
import { applyDeploy, verifyDeploy } from "./fastlane.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const rootArg = argv.includes("--root") ? argv[argv.indexOf("--root") + 1] : null;
let res;
try {
  const root = findProjectRoot(rootArg || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const target = argv.includes("--target") ? argv[argv.indexOf("--target") + 1] : "production";
  res = root ? verifyDeploy(root, { target }) : { ok: false, reason: "no maple.config.json found" };
  // A deploy script asking is a deploy happening: a fast-lane permit becomes a debt here too (the guard hook is not
  // the only caller). `--check` only looks.
  if (res.ok && res.action && !flag("--check")) applyDeploy(root, res);
} catch (e) {
  res = { ok: false, reason: "verification error: " + e.message };
}
if (flag("--json")) console.log(JSON.stringify(res));
else if (!flag("--quiet")) console.log((res.ok ? "OK: " : "REFUSED: ") + res.reason);
process.exit(res.ok ? 0 : 1);
