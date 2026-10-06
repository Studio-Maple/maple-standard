#!/usr/bin/env node
/**
 * run-tests.mjs - runner for the Jev tests, including the jev-validate-subagent hook's test (it lives in
 * plugin/hooks/ but is part of this feature) and the quality-gate audit engine's tests in jev/audit/
 * (shared runner: ../gate/run-suite.mjs).
 * Run: node plugin/scripts/jev/run-tests.mjs [--integration | --all]   (default: the unit set)
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "../gate/run-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT_DIR = join(HERE, "audit");
const extra = [
  join(HERE, "..", "..", "hooks", "jev-validate-subagent.test.mjs"),
  ...readdirSync(AUDIT_DIR).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => join(AUDIT_DIR, f)),
];
process.exit(runSuite({ dir: HERE, label: "jev", extra }));
