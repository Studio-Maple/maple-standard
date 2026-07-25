#!/usr/bin/env node
/**
 * docs-sync-reminder.js — Stop hook (the SEMANTIC docs-drift layer)
 * Part of the maple-standard plugin (plugin/hooks/hooks.json).
 *
 * The structural gate (a project's docs-drift script, if configured) catches
 * DEAD code paths, broken wikilinks, and a stale docs index. It CANNOT catch
 * a doc whose prose describes superseded behavior while its `Code:` paths
 * still resolve — that's semantic drift.
 *
 * This hook closes that gap with judgment, not blocking: it reads the
 * reverse map (code path -> owning doc) from the docs index, diffs the
 * working tree, and if code changed under a doc's declared ownership but
 * the doc itself was NOT touched, it names that doc for review (`/sync-docs`).
 *
 * Non-blocking by design (always exit 0): semantic drift is a review
 * signal, not a hard stop.
 *
 * maple.config.json keys (all optional):
 *   docs.root            default "docs"
 *   docs.indexFile        default "docs/.docs-index.json"
 *   docs.changelogFile    default "CHANGELOG.md"
 *
 * No docs.indexFile present yet (a project that hasn't run /adopt-standard's
 * index-generation step)? This hook simply has nothing to reverse-map and
 * stays silent — it does not error.
 *
 * PROJECT ROOT: the hook payload's own `cwd` field (falling back to
 * $CLAUDE_PROJECT_DIR, then process.cwd()) — not __dirname, which resolves
 * inside the plugin's install directory, not the adopting project.
 */
const { execSync } = require("child_process");
const { readFileSync } = require("fs");
const { join } = require("path");

function loadMapleConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, "maple.config.json"), "utf8"));
  } catch {
    return {};
  }
}

function readStdinPayload() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

try {
  const payload = readStdinPayload();
  const ROOT = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cfg = loadMapleConfig(ROOT);
  const docsRoot = (cfg?.docs?.root || "docs").replace(/[/\\]+$/, "");
  const indexFile = cfg?.docs?.indexFile || `${docsRoot}/.docs-index.json`;
  const changelogFile = cfg?.docs?.changelogFile || "CHANGELOG.md";

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
  const docsPrefix = `${docsRoot}/`;
  const changedCode = changed.filter((f) => codeRe.test(f) && !f.startsWith(docsPrefix));
  if (changedCode.length === 0) process.exit(0);

  const index = JSON.parse(readFileSync(join(ROOT, indexFile), "utf8"));

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
  for (const doc of index.files || []) {
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
      "DOCS-SYNC: code changed under these docs' declared ownership, but the docs were not touched — review for semantic drift (/sync-docs):"
    );
    let n = 0;
    for (const [docPath, { hits }] of implicated) {
      if (n++ >= 8) {
        lines.push(`  …and ${implicated.size - 8} more.`);
        break;
      }
      const base = docPath.replace(new RegExp(`^${docsRoot}/`), "").replace(/\.md$/, "");
      const sample = [...hits].slice(0, 2).join(", ");
      lines.push(`  • [[${base}]] — owns ${sample}${hits.size > 2 ? ` (+${hits.size - 2})` : ""}`);
    }
  }

  const hasChangelog = changed.some((f) => f === changelogFile || f.endsWith(`/${changelogFile}`));
  if (!hasChangelog) {
    lines.push(`DOCS-SYNC: code changed but ${changelogFile} was not updated — add an entry under [Unreleased].`);
  }

  if (lines.length) console.error(lines.join("\n"));
} catch {
  // Never block the Stop event on a reminder (includes: no docs index yet).
}
process.exit(0);
