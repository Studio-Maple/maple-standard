#!/usr/bin/env node
/**
 * run-tests.mjs — runs the pre-push selection/stamp/slot test
 * (prepush-lib.test.sh, bash). Hermetic: temp git repos, no network.
 *
 * Run: node plugin/scripts/prepush/run-tests.mjs
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(fileURLToPath(import.meta.url), "..");
const r = spawnSync("bash", [join(HERE, "prepush-lib.test.sh")], { stdio: "inherit" });
process.exit(r.status ?? 1);
