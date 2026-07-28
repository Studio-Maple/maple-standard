#!/usr/bin/env node
/**
 * generate-docs-index.mjs (canonical, plugin-bundled — docs/decisions.md
 * D010, docs/tasks.md #T13)
 *
 * Walks <docs.root>/**\/*.md, reads each page's preamble — OKF v0.1
 * frontmatter, falling back to the legacy prose blockquote (see
 * lib/preamble.mjs) — and emits <docs.docsIndexJson>: a machine-readable
 * map of { path, title, topic, audience, authoritative_for[],
 * anchor_type, anchor_paths[], related[] }. Same JSON shape as before
 * D010 (docs-sync-reminder.js and friends keep working unmodified), just
 * fed by a frontmatter-aware reader now.
 *
 * ALSO maintains the generated Catalog block in <docs.index> (docs/index.md
 * by default) between `<!-- catalog:begin -->` / `<!-- catalog:end -->`
 * markers — one line per page, alphabetical by basename, built from each
 * page's frontmatter `description`. A page with no frontmatter yet keeps
 * its EXISTING catalog line verbatim (looked up by basename) rather than
 * losing hand-written prose — so a partially-migrated docs/ (e.g.
 * VeHagita pre-#T5) degrades gracefully. Hand-written content outside the
 * markers is never touched. If the markers are missing entirely, catalog
 * maintenance is skipped (check-docs-drift.mjs warns about that).
 *
 * Why: an AI agent (or the ask-gate hook / doc-search) resolves "where is X
 * documented?" in one read instead of grep-and-pray over markdown.
 *
 * maple.config.json keys read (all optional — see lib/config.mjs for
 * defaults, which match this template's own flat docs/ layout):
 *   docs.root  docs.index  docs.docsIndexJson
 *
 * Run: node generate-docs-index.mjs   (or via a project's thin wrapper,
 *      e.g. this template's scripts/generate-docs-index.mjs)
 * Generic — no project-specific folder assumptions.
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import { readDocMeta } from "./lib/preamble.mjs";
import { resolveDocsConfig, defaultRoot } from "./lib/config.mjs";
import { extractCatalogBlock, spliceCatalogBlock } from "./lib/catalog.mjs";

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walk(full)));
    else if (e.isFile() && e.name.endsWith(".md")) files.push(full);
  }
  return files;
}

function extractWikilinks(content) {
  const links = new Set();
  for (const m of content.matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?(?:#[^\]]*)?\]\]/g)) {
    links.add(m[1].trim());
  }
  return [...links];
}

// m9: which line ending a file predominantly uses — CRLF if CRLF pairs
// outnumber lone LFs, else LF (also the tie-break/default for an all-LF or
// empty file).
function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const totalLf = (text.match(/\n/g) || []).length;
  const lf = totalLf - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

function topicFromPath(root, file) {
  const relToRoot = relative(root, file).replace(/\\/g, "/");
  const parts = relToRoot.split("/");
  if (parts.length === 1) return "root";
  return parts.slice(0, -1).join(".");
}

/** basename -> full existing catalog line text, so a page with no frontmatter description yet keeps its hand-written line. */
function existingCatalogLines(indexMdContent) {
  const map = new Map();
  const block = extractCatalogBlock(indexMdContent);
  if (!block) return map;
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*\[\[([^\]|#]+)/);
    if (m) map.set(basename(m[1].trim()), line.trim());
  }
  return map;
}

/**
 * Pure computation — no file writes. check-docs-drift.mjs uses this to
 * diff the WOULD-BE .docs-index.json / catalog against what's on disk
 * without mutating anything unless it's running with --fix.
 */
export async function computeIndex({ root } = {}) {
  const ROOT = root || defaultRoot();
  const cfg = resolveDocsConfig(ROOT);
  const files = await walk(cfg.root);
  const indexRel = relative(ROOT, cfg.index).replace(/\\/g, "/");

  let existingLines = new Map();
  try {
    existingLines = existingCatalogLines(await readFile(cfg.index, "utf8"));
  } catch {
    /* index.md missing/unreadable — every page falls back to the placeholder line below */
  }

  const entries = [];
  const catalogItems = [];
  for (const file of files.sort()) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (rel === indexRel) continue;
    const content = await readFile(file, "utf8");
    const meta = readDocMeta(content);
    const related = extractWikilinks(content);
    const anchor_type = meta.code.length ? "code" : meta.reference_for ? "reference_for" : null;
    entries.push({
      path: rel,
      title: meta.title || "(no H1)",
      topic: topicFromPath(cfg.root, file),
      audience: meta.audience,
      authoritative_for: meta.authoritative_for,
      anchor_type,
      anchor_paths: meta.code,
      related,
    });

    const base = basename(file, ".md");
    if (meta.description) {
      catalogItems.push(`- [[${base}]] — ${meta.description}`);
    } else if (existingLines.has(base)) {
      catalogItems.push(existingLines.get(base));
    } else {
      catalogItems.push(`- [[${base}]] — (no description yet — add frontmatter \`description\` or a catalog line)`);
    }
  }
  catalogItems.sort((a, b) => a.localeCompare(b));

  const indexJson = {
    generated: new Date().toISOString().slice(0, 10),
    generator: "plugin/scripts/docs/generate-docs-index.mjs",
    description:
      "Machine-readable map of docs/**/*.md preambles (OKF v0.1 frontmatter or legacy prose — docs/decisions.md D010). Regenerate after any preamble/description change: run this script (or check-docs-drift.mjs --fix).",
    files: entries,
  };

  return { ROOT, cfg, entries, catalogItems, indexJson };
}

/** Compute, then write docs.docsIndexJson and (if markers exist) splice the catalog into docs.index. */
export async function run({ root } = {}) {
  const { cfg, entries, catalogItems, indexJson } = await computeIndex({ root });

  await writeFile(cfg.docsIndexJson, JSON.stringify(indexJson, null, 2) + "\n", "utf8");

  let catalogResult = "skipped (no <!-- catalog:begin/end --> markers in index.md)";
  try {
    // Normalize to LF before splicing — a CRLF checkout (Windows, no
    // `*.md text eol=lf` yet) would otherwise leave the file with MIXED
    // endings: CRLF outside the markers (untouched disk content) and LF
    // inside (the freshly-generated block). Harmless for
    // check-docs-drift.mjs's own comparison (now normalized on both sides
    // — see BL-1), but avoids the noisy mixed-EOL diff regardless.
    //
    // m9: that normalization used to carry all the way through to the
    // WRITE too — a CRLF-committed index.md came back with 0 CR bytes
    // (every line flipped to LF), a whole-file EOL diff having nothing to
    // do with the actual catalog change, on any adopting project that
    // hasn't picked up the .gitattributes LF pin yet. Detect the file's
    // OWN dominant line ending before normalizing, and convert back to it
    // on write — so only the semantic content changes, never the EOL
    // style of a file this script didn't intend to touch.
    const indexMdRaw = await readFile(cfg.index, "utf8");
    const eol = dominantEol(indexMdRaw);
    const indexMd = indexMdRaw.replace(/\r\n/g, "\n");
    const spliced = spliceCatalogBlock(indexMd, catalogItems.join("\n"));
    if (spliced !== null) {
      const toWrite = eol === "\r\n" ? spliced.replace(/\n/g, "\r\n") : spliced;
      await writeFile(cfg.index, toWrite, "utf8");
      catalogResult = `${catalogItems.length} entries`;
    }
  } catch {
    catalogResult = "skipped (index.md unreadable)";
  }

  return { entries, catalogItems, catalogResult, docsIndexJson: cfg.docsIndexJson, indexPath: cfg.index };
}

function isMain() {
  if (!process.argv[1]) return false;
  const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  return import.meta.url === argvUrl;
}

async function main() {
  const { entries, catalogResult, docsIndexJson, indexPath } = await run();
  console.log(`Wrote ${entries.length} entries to ${docsIndexJson}`);
  console.log(`Catalog (${indexPath}): ${catalogResult}`);
  const missing = entries.filter((e) => !e.audience);
  if (missing.length > 0) {
    console.warn(`\n${missing.length} files missing an audience (frontmatter \`audience\` or legacy preamble \`Audience:\` label, bold or plain):`);
    for (const m of missing) console.warn(`  ${m.path}`);
  }
}

if (isMain()) {
  await main();
}
