#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, scoreOf, likely, candidateTargets, DEFAULT_CONFIDENCE_FLOOR } from "./client.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const throws = (name, fn) => {
  try {
    fn();
    check(name, false, "expected it to throw");
  } catch {
    check(name, true);
  }
};

check("default confidence floor is 0.5", DEFAULT_CONFIDENCE_FLOOR === 0.5);

check("decide() returns the label above the floor", decide({ type: "choice", choice: "opus", confidence: 0.9 }) === "opus");
check("decide() returns null below the floor", decide({ type: "choice", choice: "opus", confidence: 0.2 }) === null);
check("decide() respects a custom floor", decide({ type: "choice", choice: "opus", confidence: 0.6 }, 0.7) === null);
throws("decide() rejects a non-choice answer", () => decide({ type: "score", score: 1 }));

const s = scoreOf({ type: "score", score: 2.7, confidence: 0.8, legend: {}, probabilities: [0.1, 0.9] });
check("scoreOf() passes fields through", s.score === 2.7 && s.confidence === 0.8);
throws("scoreOf() rejects a non-score answer", () => scoreOf({ type: "choice", choice: "x" }));

check("likely() reads the noul directly", likely({ type: "noul", noul: 0.7 }) === true);
check("likely() respects a custom threshold", likely({ type: "noul", noul: 0.4 }, 0.5) === false);
throws("likely() rejects a non-noul answer", () => likely({ type: "score", score: 1 }));

// --- credential target resolution order ---
const sandbox = mkdtempSync(join(tmpdir(), "jev-client-"));
try {
  const noConfig = candidateTargets(sandbox);
  check(
    "falls back to the two documented plugin-wide targets with no config",
    JSON.stringify(noConfig) === JSON.stringify(["Maple-TypeSafe-APIKey", "MapleLens-TypeSafe-APIKey"]),
    JSON.stringify(noConfig),
  );

  writeFileSync(
    join(sandbox, "maple.config.json"),
    JSON.stringify({ project: { name: "x", slug: "x" }, jev: { credentialTarget: "Acme-TypeSafe-APIKey" } }),
  );
  const withConfig = candidateTargets(sandbox);
  check(
    "puts the project's own credentialTarget first",
    JSON.stringify(withConfig) === JSON.stringify(["Acme-TypeSafe-APIKey", "Maple-TypeSafe-APIKey", "MapleLens-TypeSafe-APIKey"]),
    JSON.stringify(withConfig),
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("All client.mjs checks passed.");
