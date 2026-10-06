#!/usr/bin/env node
/**
 * check-docs-touched.mjs - the SEMANTIC docs-drift reminder, run by the landing gate as a WARNING (D066).
 *
 * The structural docs gate (check-docs-drift.mjs) catches dead `Code:` paths, broken wikilinks and a stale index.
 * It cannot catch a doc whose prose describes superseded behaviour while its `code:` paths still resolve. This
 * check reads the reverse map (code path -> owning doc, from the docs index's per-doc `anchor_paths`, i.e. each
 * doc's frontmatter `code:`), diffs the landing range, and names every doc whose owned code changed while the
 * doc itself did not, plus a CHANGELOG.md that was not touched. It replaces the Stop-hook version of this
 * reminder (docs-sync-reminder, removed in D065): the right moment for it is the landing, not every turn.
 *
 * NON-BLOCKING by design: always exits 0; prints nothing when there is nothing to say.
 *
 *   node check-docs-touched.mjs --base <ref> [--root DIR]    changed = paths differing between <ref> and the
 *                                                            working tree (committed + uncommitted tracked edits)
 *
 * maple.config.json (all optional): docs.root (default docs), docs.docsIndexJson (default <root>/.docs-index.json),
 * docs.changelog (default CHANGELOG.md).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|sql|css|toml|ya?ml|sh)$/;

function expandBraces(s) {
  const m = s.match(/^([^{]*)\{([^}]+)\}(.*)$/);
  if (!m) return [s];
  const [, pre, opts, post] = m;
  return opts.split(",").map((o) => `${pre}${o.trim()}${post}`);
}

/** doc `code:` anchors -> checkable path prefixes (no globs/placeholders/absolute/remote refs) */
export function normalizeAnchors(raw) {
  return expandBraces(raw)
    .map((p) => p.replace(/\/?\*+$/, "").replace(/\/$/, ""))
    .filter((p) => p && !p.includes("<") && !p.includes("*") && !p.startsWith("/") && !p.startsWith("origin/") && !p.startsWith("~") && /[/.]/.test(p));
}

/** a prefix owns a file: a file-shaped prefix (has an extension) matches exactly, a directory by path prefix */
export function owns(prefix, file) {
  if (/\.[a-z0-9]+$/i.test(prefix)) return file === prefix;
  return file === prefix || file.startsWith(prefix + "/");
}

/**
 * @param {{index:{files?:{path:string,title?:string,anchor_paths?:string[]}[]}, changed:string[], docsRoot?:string, changelog?:string}} o
 * @returns {string[]} warning lines (empty = nothing to say)
 */
export function docsTouchedWarnings({ index, changed, docsRoot = "docs", changelog = "CHANGELOG.md" }) {
  const changedSet = new Set(changed);
  const docsPrefix = `${docsRoot}/`;
  const changedCode = changed.filter((f) => CODE_RE.test(f) && !f.startsWith(docsPrefix));
  if (changedCode.length === 0) return [];

  const implicated = new Map();
  for (const doc of index?.files ?? []) {
    if (!doc.anchor_paths?.length) continue;
    const prefixes = doc.anchor_paths.flatMap(normalizeAnchors);
    const hits = new Set(changedCode.filter((f) => prefixes.some((p) => owns(p, f))));
    if (hits.size && !changedSet.has(doc.path)) implicated.set(doc.path, hits);
  }

  const lines = [];
  if (implicated.size) {
    lines.push("DOCS-SYNC (warning, non-blocking): code changed under these docs' declared ownership, but the docs were not touched - review for semantic drift (/sync-docs):");
    let k = 0;
    for (const [docPath, hits] of implicated) {
      if (k++ >= 8) { lines.push(`  ...and ${implicated.size - 8} more.`); break; }
      const base = docPath.replace(new RegExp(`^${docsRoot}/`), "").replace(/\.md$/, "");
      const sample = [...hits].slice(0, 2).join(", ");
      lines.push(`  - [[${base}]] owns ${sample}${hits.size > 2 ? ` (+${hits.size - 2})` : ""}`);
    }
  }
  if (!changed.some((f) => f === changelog || f.endsWith(`/${changelog}`))) {
    lines.push(`DOCS-SYNC (warning, non-blocking): code changed but ${changelog} was not updated - add an entry under [Unreleased].`);
  }
  return lines;
}

function loadJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function run({ root, base }) {
  const cfg = loadJson(join(root, "maple.config.json"))?.docs ?? {};
  const docsRoot = (cfg.root || "docs").replace(/[/\\]+$/, "");
  const index = loadJson(join(root, cfg.docsIndexJson || `${docsRoot}/.docs-index.json`));
  if (!index) return []; // no docs index yet: nothing to reverse-map
  let out = "";
  try {
    out = execFileSync("git", ["-c", "core.quotepath=off", "diff", "--name-only", "--no-renames", base, "--"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return [];
  }
  const changed = out.split(/\r?\n/).filter(Boolean);
  return docsTouchedWarnings({ index, changed, docsRoot, changelog: cfg.changelog || "CHANGELOG.md" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = process.argv.slice(2);
  const val = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : undefined);
  const base = val("--base");
  if (!base) { process.exit(0); }
  try {
    const lines = run({ root: resolve(val("--root") || process.cwd()), base });
    if (lines.length) console.log(lines.join("\n"));
  } catch { /* a reminder never fails a gate */ }
  process.exit(0);
}
