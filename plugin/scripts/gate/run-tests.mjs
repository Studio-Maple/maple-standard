#!/usr/bin/env node
/**
 * run-tests.mjs - runner for the D066 gate tests (shared runner: ./run-suite.mjs).
 * Run: node plugin/scripts/gate/run-tests.mjs [--integration | --all]   (default: the unit set)
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "./run-suite.mjs";

process.exit(runSuite({ dir: dirname(fileURLToPath(import.meta.url)), label: "gate" }));
