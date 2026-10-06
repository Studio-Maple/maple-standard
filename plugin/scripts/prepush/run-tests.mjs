#!/usr/bin/env node
/**
 * run-tests.mjs - runs the pre-push toolkit tests (bash, hermetic: temp git repos, no network):
 *   prepush-lib.test.sh   range selection, fail-closed FULL rules, tree-bound stamp, slots, sleep fallback
 *   install-hooks.integration.test.sh (heavy) real `git push`es from real worktrees: hooks fail closed
 *   prepush-slots.integration.test.sh (heavy) gate slots with real waiting holders
 *   landing-lock.integration.test.sh (heavy) staleness fail-fast + per-branch landing lock, two real concurrent pushes
 * (shared runner: ../gate/run-suite.mjs)
 *
 * Run: node plugin/scripts/prepush/run-tests.mjs [--integration | --all]   (default: the unit set)
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "../gate/run-suite.mjs";

process.exit(runSuite({ dir: dirname(fileURLToPath(import.meta.url)), label: "prepush" }));
