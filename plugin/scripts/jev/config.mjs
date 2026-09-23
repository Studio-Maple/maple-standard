#!/usr/bin/env node
/**
 * config.mjs — `maple.config.json` `jev.*` resolver, mirrors
 * plugin/scripts/docs/lib/config.mjs's shape/defaults convention so the
 * jev.* key set reads the same way every other canonical block does.
 *
 * Schema (plugin/schema/maple.config.schema.json):
 *   jev.enabled            boolean, default true
 *   jev.credentialTarget   string, default null (client.mjs then tries
 *                          "Maple-TypeSafe-APIKey", then
 *                          "MapleLens-TypeSafe-APIKey")
 *   jev.confidenceFloor    number 0..1, default 0.5 — the floor
 *                          decide()/judgeCompletion() use when a caller
 *                          doesn't pass its own
 *   jev.timeoutMs          number, default 3000 — fail-open budget for
 *                          routing/validation calls (deliberately short:
 *                          these run inline in a hook/skill, never worth
 *                          blocking a turn over)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const JEV_DEFAULTS = {
  enabled: true,
  credentialTarget: null,
  confidenceFloor: 0.5,
  timeoutMs: 3000,
};

export function loadMapleConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, "maple.config.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * @param {string} root project root (the payload's `cwd`, never this
 *   script's own install location)
 */
export function resolveJevConfig(root) {
  const cfg = loadMapleConfig(root)?.jev ?? {};
  return {
    enabled: cfg.enabled ?? JEV_DEFAULTS.enabled,
    credentialTarget: cfg.credentialTarget ?? JEV_DEFAULTS.credentialTarget,
    confidenceFloor: cfg.confidenceFloor ?? JEV_DEFAULTS.confidenceFloor,
    timeoutMs: cfg.timeoutMs ?? JEV_DEFAULTS.timeoutMs,
  };
}
