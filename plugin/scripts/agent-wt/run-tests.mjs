#!/usr/bin/env node
/**
 * run-tests.mjs - runner for the agent-wt worktree-lifecycle tests (shared runner: ../gate/run-suite.mjs).
 * Run: node plugin/scripts/agent-wt/run-tests.mjs [--integration | --all]   (default: the unit set)
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runSuite } from "../gate/run-suite.mjs";

process.exit(runSuite({ dir: dirname(fileURLToPath(import.meta.url)), label: "agent-wt" }));
