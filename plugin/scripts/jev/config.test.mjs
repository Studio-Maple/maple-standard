#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveJevConfig, JEV_DEFAULTS } from "./config.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);

const sandbox = mkdtempSync(join(tmpdir(), "jev-config-"));
try {
  eq("defaults with no maple.config.json at all", resolveJevConfig(sandbox), JEV_DEFAULTS);

  writeFileSync(join(sandbox, "maple.config.json"), JSON.stringify({ project: { name: "x", slug: "x" } }));
  eq("defaults with maple.config.json but no jev block", resolveJevConfig(sandbox), JEV_DEFAULTS);

  writeFileSync(
    join(sandbox, "maple.config.json"),
    JSON.stringify({
      project: { name: "x", slug: "x" },
      jev: { enabled: false, credentialTarget: "Acme-TypeSafe-APIKey", confidenceFloor: 0.8, timeoutMs: 5000, credentialCacheTtlSeconds: 60 },
    }),
  );
  eq("reads an explicit jev block", resolveJevConfig(sandbox), {
    enabled: false,
    credentialTarget: "Acme-TypeSafe-APIKey",
    confidenceFloor: 0.8,
    timeoutMs: 5000,
    credentialCacheTtlSeconds: 60,
  });

  writeFileSync(join(sandbox, "maple.config.json"), "{ not valid json");
  eq("falls back to defaults on malformed config", resolveJevConfig(sandbox), JEV_DEFAULTS);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("All config.mjs checks passed.");
