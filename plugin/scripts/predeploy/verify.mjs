#!/usr/bin/env node
/**
 * verify.mjs — "is there a valid predeploy stamp for HEAD?" For deploy
 * scripts (PowerShell/bash) and the guard hook. Exit 0 = yes, 1 = no.
 *
 *   node verify.mjs [--root DIR] [--quiet] [--json]
 *
 * Fails CLOSED: any error reading state is a "no".
 */
import { findProjectRoot } from "./lib.mjs";
import { verifyStamp } from "./state.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const rootArg = argv.includes("--root") ? argv[argv.indexOf("--root") + 1] : null;
let res;
try {
  const root = findProjectRoot(rootArg || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  res = root ? verifyStamp(root) : { ok: false, reason: "no maple.config.json found" };
} catch (e) {
  res = { ok: false, reason: "verification error: " + e.message };
}
if (flag("--json")) console.log(JSON.stringify(res));
else if (!flag("--quiet")) console.log((res.ok ? "OK: " : "REFUSED: ") + res.reason);
process.exit(res.ok ? 0 : 1);
