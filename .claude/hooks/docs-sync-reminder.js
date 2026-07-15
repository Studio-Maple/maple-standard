#!/usr/bin/env node
/**
 * docs-sync-reminder.js — Stop hook (the SEMANTIC docs-drift layer)
 *
 * The structural gate (scripts/check-docs-drift.mjs, in the fast tier)
 * catches DEAD code paths, broken wikilinks, and a stale
 * docs/.docs-index.json. It CANNOT catch a doc whose prose describes
 * superseded behavior while its `Code:` paths still resolve — that's
 * semantic drift.
 *
 * This hook closes that gap with judgment, not blocking: it reads the
 * reverse map (code path -> owning doc) from docs/.docs-index.json, diffs
 * the working tree, and if code changed under a doc's declared ownership
 * but the doc itself was NOT touched, it names that doc for review.
 *
 * Non-blocking by design (always exit 0): semantic drift is a review
 * signal, not a hard stop. Watches this template's flat docs/ layout.
 */
const { execSync } = require("child_process");
const { readFileSync } = require("fs");
const { join } = require("path");

try {
  const ROOT = join(__dirname, "..", "..");

  const porcelain = execSync("git status --porcelain", {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  if (!porcelain) process.exit(0);

  const changed = porcelain
    .split(/\r?\n/)
    .map((l) => {
      const p = l.slice(3);
      const arrow = p.indexOf(" -> ");
      return (arrow >= 0 ? p.slice(arrow + 4) : p).trim().replace(/^"|"$/g, "");
    })
    .filter(Boolean);
  const changedSet = new Set(changed);

  const codeRe = /\.(ts|tsx|js|jsx|mjs|cjs|sql|css|toml|ya?ml|sh)$/;
  const changedCode = changed.filter((f) => codeRe.test(f) && !f.startsWith("docs/"));
  if (changedCode.length === 0) process.exit(0);

  const index = JSON.parse(readFileSync(join(ROOT, "docs", ".docs-index.json"), "utf8"));

  function expandBraces(s) {
    const m = s.match(/^([^{]*)\{([^}]+)\}(.*)$/);
    if (!m) return [s];
    const [, pre, opts, post] = m;
    return opts.split(",").map((o) => `${pre}${o.trim()}${post}`);
  }
  function normalize(raw) {
    return expandBraces(raw)
      .map((p) => p.replace(/\/?\*+$/, "").replace(/\/$/, ""))
      .filter(
        (p) =>
          p &&
          !p.includes("<") &&
          !p.includes("*") &&
          !p.startsWith("/") &&
          !p.startsWith("origin/") &&
          /\//.test(p)
      );
  }
  function owns(prefix, file) {
    if (/\.[a-z0-9]+$/i.test(prefix)) return file === prefix;
    return file === prefix || file.startsWith(prefix + "/");
  }

  const implicated = new Map();
  for (const doc of index.files) {
    if (!doc.anchor_paths || !doc.anchor_paths.length) continue;
    const prefixes = doc.anchor_paths.flatMap(normalize);
    const hits = new Set();
    for (const f of changedCode) {
      if (prefixes.some((p) => owns(p, f))) hits.add(f);
    }
    if (hits.size && !changedSet.has(doc.path)) {
      implicated.set(doc.path, { title: doc.title, hits });
    }
  }

  const lines = [];
  if (implicated.size) {
    lines.push(
      "DOCS-SYNC: code changed under these docs' declared ownership, but the docs were not touched — review for semantic drift:"
    );
    let n = 0;
    for (const [docPath, { hits }] of implicated) {
      if (n++ >= 8) {
        lines.push(`  …and ${implicated.size - 8} more.`);
        break;
      }
      const base = docPath.replace(/^docs\//, "").replace(/\.md$/, "");
      const sample = [...hits].slice(0, 2).join(", ");
      lines.push(`  • [[${base}]] — owns ${sample}${hits.size > 2 ? ` (+${hits.size - 2})` : ""}`);
    }
  }

  const hasChangelog = changed.some((f) => f.includes("CHANGELOG.md"));
  if (!hasChangelog) {
    lines.push("DOCS-SYNC: code changed but CHANGELOG.md was not updated — add an entry under [Unreleased].");
  }

  if (lines.length) console.error(lines.join("\n"));
} catch {
  // Never block the Stop event on a reminder.
}
process.exit(0);
