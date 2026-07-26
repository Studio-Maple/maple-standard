#!/usr/bin/env node
/**
 * ledger.mjs (loop pack, docs/tasks.md #T8) — /dev-burner's cycle ledger:
 * one JSON line per cycle appended to `.loop-state/dev-burner-ledger.jsonl`
 * (docs/loop-pack.md orchestrator step 6 — "the primary artifact the
 * morning review reads"). Each entry:
 *   { ts, loop, outcome, commit, budgetUsed }
 * ts: ISO timestamp. loop: one of the four loop names. outcome: whatever
 * that loop's command reports this cycle (e.g. "fixed" / "quiet" / "noise" /
 * "budget-exceeded" / "gate-red" / "done" / "aborted" — loop-specific, see
 * each command file's "Next-action logic"/"Failure handling"). commit: the
 * short SHA landed on the standing branch this cycle, or null. budgetUsed:
 * `{ turns, minutes }` actually consumed this cycle.
 *
 * Append is a plain newline-terminated `appendFileSync` — NOT the tmp+rename
 * atomic write state.mjs uses, because this is a single-writer append-only
 * log (one standing /dev-burner session), not a read-modify-write file.
 * A crash mid-append can at worst leave a trailing partial line, which
 * `readLedgerEntries` skips with a warning rather than failing the whole
 * read.
 *
 * Importable:
 *   ledgerFilePath(root)
 *   validateLedgerEntry(entry) -> string[] (problems; empty = valid)
 *   appendLedgerEntry(root, entry) -> absolute path (throws on invalid entry)
 *   readLedgerEntries(root) -> { entries, warnings }
 *   summarizeLedger(root) -> the morning-review summary object
 *
 * CLI:
 *   node ledger.mjs append [--root <path>]          <- JSON entry on stdin
 *   node ledger.mjs summarize [--root <path>] [--json]
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loopStateDir } from "./state.mjs";

export function ledgerFilePath(root) {
  return join(loopStateDir(root), "dev-burner-ledger.jsonl");
}

const REQUIRED_FIELDS = ["ts", "loop", "outcome", "commit", "budgetUsed"];

/** @returns {string[]} problems (empty array = valid) */
export function validateLedgerEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return ["entry must be a JSON object"];
  }
  const problems = [];
  for (const f of REQUIRED_FIELDS) {
    if (!(f in entry)) problems.push(`missing required field "${f}"`);
  }
  if ("ts" in entry && typeof entry.ts !== "string") problems.push('"ts" must be a string (ISO timestamp)');
  if ("loop" in entry && typeof entry.loop !== "string") problems.push('"loop" must be a string');
  if ("outcome" in entry && typeof entry.outcome !== "string") problems.push('"outcome" must be a string');
  if ("commit" in entry && entry.commit !== null && typeof entry.commit !== "string") {
    problems.push('"commit" must be a string or null');
  }
  return problems;
}

export function appendLedgerEntry(root, entry) {
  const problems = validateLedgerEntry(entry);
  if (problems.length > 0) {
    throw new Error(`invalid ledger entry: ${problems.join("; ")}`);
  }
  const dir = loopStateDir(root);
  mkdirSync(dir, { recursive: true });
  const file = ledgerFilePath(root);
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  return file;
}

/** Tolerant read: corrupt/partial lines are skipped with a warning, never
 * thrown — one bad line shouldn't hide the rest of the history from
 * morning review. Returns entries in file order (oldest cycle first). */
export function readLedgerEntries(root) {
  const file = ledgerFilePath(root);
  if (!existsSync(file)) return { entries: [], warnings: [] };
  const raw = readFileSync(file, "utf8");
  const entries = [];
  const warnings = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      warnings.push(`line ${i + 1}: invalid JSON (${e.message}) — skipped`);
      continue;
    }
    const problems = validateLedgerEntry(parsed);
    if (problems.length > 0) {
      warnings.push(`line ${i + 1}: ${problems.join("; ")} — skipped`);
      continue;
    }
    entries.push(parsed);
  }
  return { entries, warnings };
}

/** Morning-review summary: cycle count, per-loop breakdown, commit list. */
export function summarizeLedger(root) {
  const { entries, warnings } = readLedgerEntries(root);
  const perLoop = {};
  const commits = [];
  for (const e of entries) {
    if (!perLoop[e.loop]) perLoop[e.loop] = { count: 0, outcomes: {} };
    perLoop[e.loop].count++;
    perLoop[e.loop].outcomes[e.outcome] = (perLoop[e.loop].outcomes[e.outcome] || 0) + 1;
    if (e.commit) commits.push({ loop: e.loop, commit: e.commit, ts: e.ts });
  }
  return {
    totalCycles: entries.length,
    firstTs: entries[0]?.ts ?? null,
    lastTs: entries[entries.length - 1]?.ts ?? null,
    perLoop,
    commits,
    warnings,
  };
}

// ---- CLI --------------------------------------------------------------------

function defaultRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function parseArgs(argv) {
  const rootIdx = argv.indexOf("--root");
  const root = rootIdx !== -1 ? argv[rootIdx + 1] : defaultRoot();
  const json = argv.includes("--json");
  return { root, json };
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function printSummaryHuman(summary) {
  console.log(`Cycles: ${summary.totalCycles}  (${summary.firstTs ?? "-"} .. ${summary.lastTs ?? "-"})`);
  for (const [loop, s] of Object.entries(summary.perLoop)) {
    const outcomeStr = Object.entries(s.outcomes)
      .map(([o, n]) => `${o}:${n}`)
      .join(", ");
    console.log(`  ${loop}: ${s.count} cycle(s) — ${outcomeStr}`);
  }
  console.log(`Commits landed on the standing branch this run: ${summary.commits.length}`);
  for (const c of summary.commits) console.log(`  ${c.commit}  (${c.loop}, ${c.ts})`);
  if (summary.warnings.length > 0) {
    console.log(`\n${summary.warnings.length} ledger line warning(s):`);
    for (const w of summary.warnings) console.log(`  ${w}`);
  }
}

function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { root, json } = parseArgs(argv);
  if (cmd === "append") {
    const raw = readStdin();
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch (e) {
      console.error(`[ledger] invalid JSON on stdin: ${e.message}`);
      process.exit(1);
    }
    try {
      const file = appendLedgerEntry(root, entry);
      console.log(`OK — appended to ${file}`);
    } catch (e) {
      console.error(`[ledger] ${e.message}`);
      process.exit(1);
    }
  } else if (cmd === "summarize") {
    const summary = summarizeLedger(root);
    if (json) process.stdout.write(JSON.stringify(summary, null, 2));
    else printSummaryHuman(summary);
  } else {
    console.error("Usage: node ledger.mjs append|summarize [--root <path>] [--json]");
    process.exit(1);
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
