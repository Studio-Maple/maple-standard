#!/usr/bin/env node
/**
 * emergency.mjs — the OWNER's emergency override. Default OFF
 * (`predeploy.emergency.enabled` must be true in the committed config).
 *
 * Grants a one-sha, short-lived (default 60 min) deploy permit WITHOUT a
 * stamp. It refuses to run unless stdin AND stdout are an interactive
 * terminal and the person types the confirmation phrase, so an agent driving
 * a non-interactive shell cannot invoke it. Every grant is appended to
 * emergency.log.jsonl and persisted in the deploy ledger; the guard prints a
 * warning on each deploy it lets through under the override. Treat any
 * override as an incident: run the full gate afterwards.
 *
 *   node emergency.mjs --reason "why this cannot wait for the gate"
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { findProjectRoot, headSha, loadMapleConfig, nowIso, stateDir } from "./lib.mjs";
import { normalize } from "./config.mjs";
import { emergencyFile } from "./state.mjs";

const argv = process.argv.slice(2);
const reason = argv.includes("--reason") ? argv[argv.indexOf("--reason") + 1] : "";
const root = findProjectRoot(process.cwd());
const pd = root && normalize(loadMapleConfig(root));
if (!pd?.emergency?.enabled) { console.error("emergency override is DISABLED for this project (predeploy.emergency.enabled)."); process.exit(1); }
if (!reason || reason.trim().length < 15) { console.error('--reason "<at least 15 chars: why this cannot wait for the gate>" is required'); process.exit(1); }
if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error("refusing: this override needs an interactive terminal and the owner typing the confirmation phrase."); process.exit(1); }

const sha = headSha(root);
const phrase = `I AM THE OWNER AND ACCEPT AN UNSCANNED DEPLOY OF ${sha.slice(0, 8)}`;
console.log(`Emergency override for ${sha.slice(0, 8)}, valid ${pd.emergency.maxMinutes} min.\nReason: ${reason}\nType exactly:\n  ${phrase}`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question("> ", (answer) => {
  rl.close();
  if (answer.trim() !== phrase) { console.error("phrase mismatch — no override granted."); process.exit(1); }
  const rec = { ts: nowIso(), sha, reason: reason.trim(), by: process.env.USERNAME || process.env.USER || "unknown", expiresAt: new Date(Date.now() + pd.emergency.maxMinutes * 60000).toISOString() };
  writeFileSync(emergencyFile(root), JSON.stringify(rec, null, 2));
  appendFileSync(join(stateDir(root), "emergency.log.jsonl"), JSON.stringify(rec) + "\n");
  console.log(`granted until ${rec.expiresAt}. Run the full gate afterwards.`);
});
