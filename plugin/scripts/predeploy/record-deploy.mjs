#!/usr/bin/env node
/**
 * record-deploy.mjs — a deploy script reports how a deploy it ran ended, so a
 * deploy that FAILED does not leave "deploy debt" (a live scan owed).
 *
 *   node record-deploy.mjs --outcome failed|succeeded [--pattern ID] [--root DIR]
 *
 * Marks the most recent still-"attempted" ledger entry for HEAD. Entries with
 * no outcome count as deployed (fail closed). Only `failed` relaxes anything.
 */
import { findProjectRoot, headSha } from "./lib.mjs";
import { recordOutcome } from "./state.mjs";

const argv = process.argv.slice(2);
const get = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const outcome = get("--outcome");
if (!["failed", "succeeded"].includes(outcome)) { console.error("--outcome failed|succeeded required"); process.exit(2); }
const root = findProjectRoot(get("--root") || process.env.CLAUDE_PROJECT_DIR || process.cwd());
if (!root) { console.error("no maple.config.json"); process.exit(2); }
const rec = recordOutcome(root, { sha: headSha(root), patternId: get("--pattern"), outcome });
console.log(rec ? `recorded ${outcome} for deploy #${rec.seq} (${rec.patternId})` : "no open deploy attempt for HEAD to update");
