#!/usr/bin/env node
/**
 * warn-report.mjs — what the security controls WOULD have blocked while a project is in warn mode (D082/D083).
 * Reads <git-common-dir>/maple/security-log.jsonl (written by hooks/guards/security-mode.mjs; never values)
 * and prints counts per control and rule, plus the project's mode and enforceAfter date. The owner reviews
 * this before a project's flip to enforce.
 *
 *   node warn-report.mjs [repoRoot] [--days N] [--json]
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function summarize(lines, sinceMs = 0) {
  const byControl = {};
  let total = 0;
  for (const line of lines) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || Date.parse(e.at) < sinceMs) continue;
    total++;
    const c = (byControl[e.control] ??= { total: 0, rules: {}, subjects: new Set() });
    c.total++;
    c.rules[e.rule] = (c.rules[e.rule] ?? 0) + 1;
    if (e.subject && c.subjects.size < 10) c.subjects.add(String(e.subject));
  }
  for (const c of Object.values(byControl)) c.subjects = [...c.subjects];
  return { total, byControl };
}

function main(argv) {
  const json = argv.includes("--json");
  const di = argv.indexOf("--days");
  const days = di >= 0 ? Number(argv[di + 1]) : 30;
  const root = resolve(argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--days") || process.cwd());
  const r = spawnSync("git", ["-C", root, "rev-parse", "--git-common-dir"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) { console.error("warn-report: not a git repository"); return 2; }
  const common = r.stdout.trim();
  const file = join(isAbsolute(common) ? common : resolve(root, common), "maple", "security-log.jsonl");
  let sec = {};
  try { sec = JSON.parse(readFileSync(join(root, "maple.config.json"), "utf8")).security ?? {}; } catch { /* none */ }
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : [];
  const out = { file, mode: sec.mode ?? "warn", enforceAfter: sec.enforceAfter ?? null, days, ...summarize(lines, Date.now() - days * 86400_000) };
  if (json) { console.log(JSON.stringify(out, null, 2)); return 0; }
  console.log(`security warn log (last ${days} days): ${out.total} would-be block(s); mode ${out.mode}${out.enforceAfter ? `, enforce from ${out.enforceAfter}` : " (no enforceAfter set)"}`);
  for (const [control, c] of Object.entries(out.byControl)) {
    console.log(`  ${control}: ${c.total}  (${Object.entries(c.rules).map(([k, v]) => `${k} x${v}`).join(", ")})`);
    if (c.subjects.length) console.log(`    e.g. ${c.subjects.join(" | ")}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
