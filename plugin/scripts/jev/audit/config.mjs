#!/usr/bin/env node
/**
 * `maple.config.json` `quality.jevAudit` resolver — the plugin-canonical
 * config surface for the per-function Jev quality audit/gate (ported from
 * MapleLens's tools/jev/audit.config.json; see plugin/scripts/jev/audit/README.md
 * and docs/decisions.md D051 — gates belong in the plugin).
 *
 * Every key is optional; a project with no `quality.jevAudit` block at all
 * gets `enabled: false` (opt-in — a fresh maple-standard adopter should not
 * silently start sending source to a third-party model) and otherwise the
 * same defaults MapleLens's own audit.config.json shipped with.
 *
 * `thresholds` are the BLOCKING-RULE constants used by gate.mjs — documented
 * there as uncalibrated and env-overridable, same house style as
 * audit-questions.mjs/audit-fingerprint.mjs's tuning constants.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_THRESHOLDS = {
  // Rule 2: a near-duplicate pair is blocking when Jev's "same job?" probability is at least this.
  nearDuplicateProbability: Number(process.env.MAPLE_QUALITY_GATE_NEAR_DUP_P || 0.9),
  // Rule 3: security score (0..4) at or above this, with confidence at or above securityConfidenceFloor, blocks.
  securityScoreFloor: Number(process.env.MAPLE_QUALITY_GATE_SECURITY_SCORE || 3),
  securityConfidenceFloor: Number(process.env.MAPLE_QUALITY_GATE_SECURITY_CONFIDENCE || 0.6),
  // Rule 4: can_fail >= canFailFloor AND error_handling < errorHandlingCeiling (and not a deliberate best-effort catch) blocks.
  canFailFloor: Number(process.env.MAPLE_QUALITY_GATE_CAN_FAIL || 0.7),
  errorHandlingCeiling: Number(process.env.MAPLE_QUALITY_GATE_ERROR_HANDLING || 0.2),
  // Rule 5: efficiency score (0..4) at or above this blocks.
  efficiencyScoreFloor: Number(process.env.MAPLE_QUALITY_GATE_EFFICIENCY_SCORE || 3),
};

export const JEV_AUDIT_DEFAULTS = {
  enabled: false,
  slug: null, // derived from project.slug when unset
  baseBranch: null, // resolved at run time: landing target -> repo.devBranch -> "main"
  scopeDirs: ["src", "lib", "app", "scripts", "tools"],
  extensions: [".ts", ".tsx", ".mjs", ".js"],
  excludeGlobs: [
    "**/*.test.*",
    "**/*.test-util.*",
    "**/*.spec.*",
    "**/*test-helper*",
    "**/test/**",
    "**/tests/**",
    "**/__tests__/**",
    "**/fixtures/**",
    "**/*.fixture.*",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/public/**/vendor/**",
    "**/*.d.ts",
    "**/*.generated.*",
    "**/*.gen.*",
    "**/*.config.*",
  ],
  denylistPatterns: ["cred", "secret", "auth", "token", "security", "password", "apikey", "api[_-]?key"],
  denylistFiles: [],
  denylistDirs: [],
  moduleLabels: {},
  trivialMaxStatements: 3,
  trivialMaxLines: 4,
  maxSourceBytes: 6144,
  shingleSize: 5,
  jaccardThreshold: 0.6,
  jevPairCap: 200,
  thresholds: DEFAULT_THRESHOLDS,
};

function loadMapleConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, "maple.config.json"), "utf8"));
  } catch {
    return {};
  }
}

/** @param {string} root the TARGET repo root (never this plugin's own install location) */
export function resolveJevAuditConfig(root) {
  const full = loadMapleConfig(root);
  const cfg = full?.quality?.jevAudit ?? {};
  const merged = { ...JEV_AUDIT_DEFAULTS, ...cfg };
  merged.thresholds = { ...DEFAULT_THRESHOLDS, ...(cfg.thresholds ?? {}) };
  merged.slug = merged.slug ?? full?.project?.slug ?? "quality-audit";
  return merged;
}
