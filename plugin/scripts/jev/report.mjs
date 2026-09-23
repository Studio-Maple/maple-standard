#!/usr/bin/env node
/**
 * report.mjs — summarize `.maple/jev-decisions.jsonl` so routing/validation
 * quality can be reviewed (goal: "add a tiny scripts/jev/report.mjs").
 *
 * Usage: node plugin/scripts/jev/report.mjs [root]
 */
import { readDecisions } from "./log.mjs";

export function summarize(records) {
  const byKind = new Map();
  for (const r of records) {
    const kind = r.kind || "unknown";
    if (!byKind.has(kind)) byKind.set(kind, { count: 0, jev: 0, fallback: 0, blocked: 0, confidenceSum: 0, confidenceN: 0 });
    const s = byKind.get(kind);
    s.count++;
    if (r.source === "jev") s.jev++;
    else s.fallback++;
    if (r.block) s.blocked++;
    if (typeof r.confidence === "number") {
      s.confidenceSum += r.confidence;
      s.confidenceN++;
    }
  }
  const rows = [...byKind.entries()].map(([kind, s]) => ({
    kind,
    count: s.count,
    jevRate: s.count ? +(s.jev / s.count).toFixed(2) : 0,
    blockedRate: s.count ? +(s.blocked / s.count).toFixed(2) : 0,
    avgConfidence: s.confidenceN ? +(s.confidenceSum / s.confidenceN).toFixed(2) : null,
  }));
  rows.sort((a, b) => b.count - a.count);
  return { total: records.length, rows };
}

function main() {
  const root = process.argv[2] || process.cwd();
  const records = readDecisions(root);
  const { total, rows } = summarize(records);
  if (total === 0) {
    console.log(`No Jev decisions logged yet under ${root}/.maple/jev-decisions.jsonl`);
    return;
  }
  console.log(`Jev decisions: ${total} total\n`);
  console.log("kind".padEnd(20), "count".padStart(6), "jevRate".padStart(9), "blockedRate".padStart(12), "avgConfidence".padStart(14));
  for (const r of rows) {
    console.log(
      r.kind.padEnd(20),
      String(r.count).padStart(6),
      String(r.jevRate).padStart(9),
      String(r.blockedRate).padStart(12),
      String(r.avgConfidence ?? "-").padStart(14),
    );
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  return import.meta.url === argvUrl;
}

if (isMain()) {
  main();
}
