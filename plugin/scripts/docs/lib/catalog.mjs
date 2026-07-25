#!/usr/bin/env node
/**
 * catalog.mjs — the generated Catalog block in docs/index.md, between
 * `<!-- catalog:begin -->` / `<!-- catalog:end -->` markers. Shared by
 * generate-docs-index.mjs (writes it) and check-docs-drift.mjs (diffs it
 * for staleness — docs/decisions.md D010).
 *
 * Hand-written content outside the markers is never touched by either
 * function below.
 */

export const CATALOG_BEGIN = "<!-- catalog:begin -->";
export const CATALOG_END = "<!-- catalog:end -->";

/** @param entries [{basename, description}] already sorted as desired */
export function buildCatalogBlock(entries) {
  return entries.map((e) => `- [[${e.basename}]] — ${e.description}`).join("\n");
}

/** The block currently between markers, trimmed — or null if markers are absent/malformed. */
export function extractCatalogBlock(indexMdContent) {
  const start = indexMdContent.indexOf(CATALOG_BEGIN);
  const end = indexMdContent.indexOf(CATALOG_END);
  if (start === -1 || end === -1 || end < start) return null;
  return indexMdContent.slice(start + CATALOG_BEGIN.length, end).trim();
}

/** Replace the block between markers with `block`, preserving everything else verbatim. Null if markers are absent/malformed. */
export function spliceCatalogBlock(indexMdContent, block) {
  const start = indexMdContent.indexOf(CATALOG_BEGIN);
  const end = indexMdContent.indexOf(CATALOG_END);
  if (start === -1 || end === -1 || end < start) return null;
  const before = indexMdContent.slice(0, start + CATALOG_BEGIN.length);
  const after = indexMdContent.slice(end);
  return `${before}\n${block}\n${after}`;
}
