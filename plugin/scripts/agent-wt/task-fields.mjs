#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDocsConfig } from "../docs/lib/config.mjs";

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fieldKeyOf(line) {
  const m = /^(?: {2,}|\t+)([^:\s][^:]*):(?:\s.*)?$/.exec(line);
  return m ? m[1] : null;
}

/**
 * Set indented key/value field lines under the task whose bold title starts
 * with `**<ref> `. Pure: returns updated text, throws if ref is not found.
 * @param {string} text
 * @param {string} ref
 * @param {Record<string,string>|Iterable<[string,string]>} fields
 */
export function setTaskFields(text, ref, fields) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r\n|\n/);
  const entries = fields instanceof Map || Symbol.iterator in Object(fields)
    ? Array.from(fields)
    : Object.entries(fields);

  const taskRe = new RegExp(`^- \\[[^\\]]+\\] \\*\\*${escapeRegExp(ref)} `);
  const start = lines.findIndex((line) => taskRe.test(line));
  if (start === -1) throw new Error(`task ${ref} not found in tasks ledger`);

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- \[[^\]]+\] /.test(lines[i])) {
      end = i;
      break;
    }
  }

  let insertAt = start + 1;
  while (insertAt < end && fieldKeyOf(lines[insertAt]) !== null) insertAt++;

  const next = lines.slice();
  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey);
    const value = String(rawValue);
    let replaced = false;
    for (let i = start + 1; i < end; i++) {
      if (fieldKeyOf(next[i]) === key) {
        next[i] = `  ${key}: ${value}`;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      next.splice(insertAt, 0, `  ${key}: ${value}`);
      insertAt++;
      end++;
    }
  }

  return next.join(eol);
}

function usage() {
  return "usage: node task-fields.mjs --root <repo> --task <ref> --set key=value [--set key=value ...]";
}

async function main(argv) {
  let root = "";
  let task = "";
  const sets = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") root = argv[++i] || "";
    else if (arg === "--task") task = argv[++i] || "";
    else if (arg === "--set") {
      const v = argv[++i] || "";
      const eq = v.indexOf("=");
      if (eq <= 0) throw new Error(`invalid --set '${v}' (${usage()})`);
      sets.push([v.slice(0, eq), v.slice(eq + 1)]);
    } else {
      throw new Error(`unknown argument '${arg}' (${usage()})`);
    }
  }
  if (!root || !task || sets.length === 0) throw new Error(usage());

  const tasksFile = resolveDocsConfig(root).tasks;
  const text = readFileSync(tasksFile, "utf8");
  const updated = setTaskFields(text, task, sets);
  writeFileSync(tasksFile, updated, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}
