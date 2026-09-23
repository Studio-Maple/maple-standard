import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_THRESHOLDS, JEV_AUDIT_DEFAULTS, resolveJevAuditConfig } from "./config.mjs";

function tmpRepo(mapleConfig) {
  const dir = mkdtempSync(join(tmpdir(), "maple-quality-cfg-"));
  if (mapleConfig !== undefined) {
    writeFileSync(join(dir, "maple.config.json"), JSON.stringify(mapleConfig));
  }
  return dir;
}

test("resolveJevAuditConfig defaults to disabled when there is no maple.config.json", () => {
  const dir = tmpRepo();
  const cfg = resolveJevAuditConfig(dir);
  assert.equal(cfg.enabled, false);
  assert.deepEqual(cfg.thresholds, DEFAULT_THRESHOLDS);
});

test("resolveJevAuditConfig defaults to disabled when maple.config.json has no quality.jevAudit block", () => {
  const dir = tmpRepo({ project: { name: "x", slug: "x" } });
  const cfg = resolveJevAuditConfig(dir);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.slug, "x"); // falls back to project.slug
});

test("resolveJevAuditConfig merges quality.jevAudit over the defaults, key by key", () => {
  const dir = tmpRepo({
    project: { name: "x", slug: "x" },
    quality: { jevAudit: { enabled: true, scopeDirs: ["app/src"], thresholds: { efficiencyScoreFloor: 4 } } },
  });
  const cfg = resolveJevAuditConfig(dir);
  assert.equal(cfg.enabled, true);
  assert.deepEqual(cfg.scopeDirs, ["app/src"]);
  assert.equal(cfg.thresholds.efficiencyScoreFloor, 4);
  // untouched threshold keys keep their default
  assert.equal(cfg.thresholds.securityScoreFloor, DEFAULT_THRESHOLDS.securityScoreFloor);
  // untouched top-level keys keep their default
  assert.deepEqual(cfg.extensions, JEV_AUDIT_DEFAULTS.extensions);
});

test("resolveJevAuditConfig lets quality.jevAudit.slug override project.slug", () => {
  const dir = tmpRepo({ project: { name: "x", slug: "x" }, quality: { jevAudit: { slug: "custom" } } });
  assert.equal(resolveJevAuditConfig(dir).slug, "custom");
});
