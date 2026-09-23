#!/usr/bin/env node
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logDecision, readDecisions } from "./log.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const sandbox = mkdtempSync(join(tmpdir(), "jev-log-"));
try {
  check("reads empty before anything is logged", readDecisions(sandbox).length === 0);

  logDecision(sandbox, { kind: "route", executor: "sonnet", source: "fallback" });
  logDecision(sandbox, { kind: "route", executor: "opus", source: "jev", confidence: 0.9 });

  const records = readDecisions(sandbox);
  check("logs both records", records.length === 2, `got ${records.length}`);
  check("stamps a timestamp", typeof records[0].ts === "string" && records[0].ts.length > 0);
  check("preserves fields", records[1].executor === "opus" && records[1].confidence === 0.9);

  check(".gitignore gets a .maple/ entry", readFileSync(join(sandbox, ".gitignore"), "utf8").includes(".maple/"));

  // Never throws even with a garbage line in the file.
  const path = join(sandbox, ".maple", "jev-decisions.jsonl");
  const original = readFileSync(path, "utf8");
  appendFileSync(path, "not json\n");
  const withGarbage = readDecisions(sandbox);
  check("skips unparseable lines instead of throwing", withGarbage.length === 2, `got ${withGarbage.length}`);
  void original;
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("All log.mjs checks passed.");
