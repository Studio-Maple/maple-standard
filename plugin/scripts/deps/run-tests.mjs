#!/usr/bin/env node
/**
 * run-tests.mjs - runner for the dependency-freshness tests, incl. hook.test.mjs (the dispatcher-level
 * dep-version-guard + install-guard test) (shared runner: ../gate/run-suite.mjs).
 * Run: node plugin/scripts/deps/run-tests.mjs [--integration | --all]   (default: the unit set)
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "../gate/run-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
process.exit(runSuite({ dir: HERE, label: "deps" }));
