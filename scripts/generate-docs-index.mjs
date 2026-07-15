#!/usr/bin/env node
/**
 * generate-docs-index.mjs
 *
 * Walks docs/**\/*.md, parses the 3-line preamble of each file, emits
 * docs/.docs-index.json — a machine-readable map of:
 *   { path, title, topic, audience, authoritative_for[], anchor_paths[], related[] }
 *
 * Why: an AI agent (or the ask-gate hook / doc-search) resolves "where is X
 * documented?" in one read instead of grep-and-pray over markdown.
 *
 * Run: node scripts/generate-docs-index.mjs
 * Generic — no project-specific folder assumptions.
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DOCS = join(ROOT, "docs");
const OUTPUT = join(DOCS, ".docs-index.json");

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      files.push(full);
    }
  }
  return files;
}

function parsePreamble(content) {
  // Expected shape:
  // # Title
  //
  // > **Audience:** ...
  // > **Authoritative for:** ...
  // > **Code:** ... | Enforced by: ... | Updated by: ... | Reference for: ...
  const lines = content.split(/\r?\n/);
  let title = "";
  let i = 0;
  while (i < lines.length && !lines[i].startsWith("# ")) i++;
  if (i < lines.length) {
    title = lines[i].replace(/^#\s+/, "").trim();
    i++;
  }
  while (i < lines.length && lines[i].trim() === "") i++;

  const preamble = { audience: null, authoritative_for: [], anchor_paths: [], anchor_type: null };
  const blockquoteLines = [];
  while (i < lines.length && lines[i].startsWith(">")) {
    blockquoteLines.push(lines[i].replace(/^>\s?/, ""));
    i++;
  }
  const block = blockquoteLines.join("\n");

  const audienceMatch = block.match(/\*\*Audience:\*\*\s*(.+?)(?=\n|$)/);
  if (audienceMatch) preamble.audience = audienceMatch[1].trim().replace(/\.$/, "");

  const authMatch = block.match(/\*\*Authoritative for:\*\*\s*(.+?)(?=\n|$)/);
  if (authMatch) {
    preamble.authoritative_for = authMatch[1]
      .replace(/\.$/, "")
      .split(/,\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  for (const label of ["Code", "Enforced by", "Updated by", "Reference for", "Machine-readable"]) {
    const re = new RegExp(`\\*\\*${label.replace(/\s/g, "\\s")}:\\*\\*\\s*(.+?)(?=\\n|$)`);
    const m = block.match(re);
    if (m) {
      preamble.anchor_type = label.toLowerCase().replace(/\s/g, "_");
      const paths = [...m[1].matchAll(/`([^`]+)`/g)].map((mm) => mm[1]);
      preamble.anchor_paths = paths;
      break;
    }
  }

  return { title, ...preamble };
}

function extractWikilinks(content) {
  const links = new Set();
  for (const m of content.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?(?:#[^\]]*)?\]\]/g)) {
    links.add(m[1].trim());
  }
  return [...links];
}

function topicFromPath(relPath) {
  // docs/architecture.md -> "root"
  // docs/features/auth.md -> "features"
  const parts = relPath.split(/[\\/]/);
  if (parts.length === 2) return "root";
  return parts.slice(1, -1).join(".");
}

async function main() {
  const files = await walk(DOCS);
  const entries = [];
  for (const file of files.sort()) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (rel === "docs/index.md") continue;
    const content = await readFile(file, "utf8");
    const pre = parsePreamble(content);
    const related = extractWikilinks(content);
    entries.push({
      path: rel,
      title: pre.title || "(no H1)",
      topic: topicFromPath(rel),
      audience: pre.audience,
      authoritative_for: pre.authoritative_for,
      anchor_type: pre.anchor_type,
      anchor_paths: pre.anchor_paths,
      related,
    });
  }

  const index = {
    generated: new Date().toISOString().slice(0, 10),
    generator: "scripts/generate-docs-index.mjs",
    description:
      "Machine-readable map of docs/**/*.md preambles. Regenerate after any preamble change: node scripts/generate-docs-index.mjs (or check-docs-drift.mjs --fix).",
    files: entries,
  };

  await writeFile(OUTPUT, JSON.stringify(index, null, 2) + "\n", "utf8");
  console.log(`Wrote ${entries.length} entries to ${relative(ROOT, OUTPUT)}`);
  const missing = entries.filter((e) => !e.audience);
  if (missing.length > 0) {
    console.warn(`\n${missing.length} files missing Audience preamble:`);
    for (const m of missing) console.warn(`  ${m.path}`);
  }
}

await main();
