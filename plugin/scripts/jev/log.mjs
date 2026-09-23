#!/usr/bin/env node
/**
 * log.mjs — local JSONL decision log so routing/validation quality can be
 * reviewed later (plugin/scripts/jev/report.mjs reads this back).
 *
 * Lives at `<root>/.maple/jev-decisions.jsonl`, gitignored (see the
 * .gitignore append below — mirrors maple-start.sh's own
 * maple_ensure_gitignored self-heal pattern for `.worktrees/`). Never
 * throws: a logging failure must not break the routing/validation call it
 * is recording.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR_NAME = ".maple";
const FILE_NAME = "jev-decisions.jsonl";

function ensureGitignored(root) {
  const giPath = join(root, ".gitignore");
  const entry = `${DIR_NAME}/`;
  try {
    const existing = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
    if (existing.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === DIR_NAME)) return;
    const sep = existing && !existing.endsWith("\n") ? "\n" : "";
    writeFileSync(giPath, `${existing}${sep}\n# maple-standard jev decision log (plugin/scripts/jev/log.mjs)\n${entry}\n`);
  } catch {
    /* best-effort — never block the caller over .gitignore hygiene */
  }
}

/**
 * @param {string} root project root
 * @param {object} record plain-JSON-serializable record. Caller is
 *   responsible for redaction (see redact.mjs) — this module writes
 *   whatever it's given.
 */
export function logDecision(root, record) {
  try {
    const dir = join(root, DIR_NAME);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      ensureGitignored(root);
    }
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
    appendFileSync(join(dir, FILE_NAME), line, "utf8");
  } catch {
    /* logging is best-effort and must never throw into the caller */
  }
}

/** @param {string} root @returns {object[]} */
export function readDecisions(root) {
  const path = join(root, DIR_NAME, FILE_NAME);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export const LOG_FILE_NAME = FILE_NAME;
export const LOG_DIR_NAME = DIR_NAME;
