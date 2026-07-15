#!/usr/bin/env node
/**
 * check-docs-drift.mjs
 *
 * Lint gate for the docs/ folder. Flattened for a
 * starter-sized docs/ (no system/features/quality/dev/state subfolders —
 * add them back as your docs/ grows; update the path assumptions below if
 * you do).
 *
 * ERRORS (block):
 *   1. A docs/**\/*.md preamble `Code:` path no longer exists.
 *   3. docs/.docs-index.json is stale vs the current preambles.
 *   5. A committed doc missing from the index.md catalog, or a duplicate
 *      wikilink on one catalog line.
 *   6. A #T id defined on >1 task bullet in tasks.md, or an S id on >1
 *      `## S###` header in log.md (use scripts/next-task-id.mjs).
 *   8. A decisions.md D### entry over 600 chars.
 *   9. A tasks.md entry block over 600 chars (condensed bullets only).
 *  10. A log.md session entry over 600 chars.
 * WARNS (surface):
 *   2. A wikilink [[X]] that doesn't resolve to a real .md basename.
 *   4. An untracked (never-committed) doc.
 *   7. A doc with no `Code:`/`Reference for:` anchor.
 *   9b. A lingering closed `- [x]` entry in tasks.md (sweep it).
 *  11. A gaps.md entry over 600 chars.
 *
 * Run: node scripts/check-docs-drift.mjs
 *      node scripts/check-docs-drift.mjs --fix    (regenerates .docs-index.json)
 *
 * Exit code: 0 = clean, 1 = error found. Wired into scripts/ci-local.* fast tier.
 */

import { readFile, readdir, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const DOCS = join(ROOT, "docs");
const INDEX_JSON = join(DOCS, ".docs-index.json");
const FIX = process.argv.includes("--fix");

let warnings = 0;
let errors = 0;

function warn(msg) {
  console.warn(`[warn] ${msg}`);
  warnings++;
}
function error(msg) {
  console.error(`[error] ${msg}`);
  errors++;
}
async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function walkMd(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walkMd(full)));
    else if (e.isFile() && e.name.endsWith(".md")) files.push(full);
  }
  return files;
}

function extractCodePaths(content) {
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].startsWith("# ")) i++;
  i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  const block = [];
  while (i < lines.length && lines[i].startsWith(">")) {
    block.push(lines[i].replace(/^>\s?/, ""));
    i++;
  }
  const joined = block.join("\n");
  const m = joined.match(/\*\*(?:Code|Enforced by):\*\*\s*(.+?)(?=\n|$)/);
  if (!m) return [];
  return [...m[1].matchAll(/`([^`]+)`/g)].map((mm) => mm[1]);
}

// Strip fenced/inline code before scanning for wikilinks — code syntax
// legitimately uses double brackets (TOML tables, Bash `[[ -f x ]]`, etc).
function stripCode(content) {
  return content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

function extractWikilinks(content) {
  return [...stripCode(content).matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?(?:#[^\]]*)?\]\]/g)].map((mm) =>
    mm[1].trim()
  );
}

async function main() {
  const docFiles = await walkMd(DOCS);
  console.log(`Scanning ${docFiles.length} markdown files in docs/...`);

  const basenameMap = new Map();
  for (const f of docFiles) {
    const base = basename(f, ".md");
    if (basenameMap.has(base)) {
      warn(`Duplicate basename "${base}": ${basenameMap.get(base)} AND ${f}`);
    }
    basenameMap.set(base, f);
  }

  // 1. Code: paths exist.
  function expandBraces(s) {
    const m = s.match(/^([^{]*)\{([^}]+)\}(.*)$/);
    if (!m) return [s];
    const [, pre, opts, post] = m;
    return opts.split(",").map((o) => `${pre}${o.trim()}${post}`);
  }
  for (const file of docFiles) {
    const content = await readFile(file, "utf8");
    const rel = relative(ROOT, file);
    if (/\bplanned\b|not yet implemented/i.test(content.slice(0, 1500))) continue;
    const codePaths = extractCodePaths(content);
    for (const cp of codePaths) {
      if (cp.includes("*") || cp.startsWith("origin/") || cp.startsWith("../") || cp.startsWith("/")) continue;
      if (/[<>=\s]/.test(cp)) continue;
      if (!/[/.]/.test(cp)) continue;
      for (const expanded of expandBraces(cp)) {
        const cleaned = expanded.replace(/\/?\*\*$/, "").replace(/\/$/, "");
        const abs = join(ROOT, cleaned);
        if (!(await exists(abs))) {
          error(`${rel} preamble references missing path: \`${expanded}\``);
        }
      }
    }
  }

  // 2. Wikilinks resolve.
  const ignoredLinks = new Set(["README", "wikilink", "wikilinks", "path", "name"]);
  for (const file of docFiles) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (rel === "docs/log.md") continue; // historical, may reference deleted docs
    const content = await readFile(file, "utf8");
    const links = extractWikilinks(content);
    for (const link of links) {
      if (link.includes("/") && /\.[a-z]+$/.test(link)) continue;
      if (link.startsWith(".claude/")) continue;
      const base = basename(link);
      if (ignoredLinks.has(link) || ignoredLinks.has(base)) continue;
      if (!basenameMap.has(base)) {
        warn(`${rel}: unresolved wikilink [[${link}]]`);
      }
    }
  }

  // 3. .docs-index.json freshness.
  if (!(await exists(INDEX_JSON))) {
    error(`.docs-index.json missing — run: node scripts/generate-docs-index.mjs`);
  } else {
    const index = JSON.parse(await readFile(INDEX_JSON, "utf8"));
    const indexedPaths = new Set(index.files.map((f) => f.path));
    const onDiskPaths = new Set(
      docFiles.map((f) => relative(ROOT, f).replace(/\\/g, "/")).filter((p) => p !== "docs/index.md")
    );
    const missing = [...onDiskPaths].filter((p) => !indexedPaths.has(p));
    const stale = [...indexedPaths].filter((p) => !onDiskPaths.has(p));
    if (missing.length || stale.length) {
      if (FIX) {
        console.log(`[fix] Regenerating .docs-index.json...`);
        spawnSync("node", [join(ROOT, "scripts", "generate-docs-index.mjs")], { stdio: "inherit" });
      } else {
        for (const p of missing) error(`.docs-index.json missing entry: ${p}`);
        for (const p of stale) error(`.docs-index.json stale entry (file gone): ${p}`);
        console.error(`\n  -> Run: node scripts/check-docs-drift.mjs --fix`);
      }
    }
  }

  // 4. Untracked docs.
  const lsOthers = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "docs"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (lsOthers.status === 0 && lsOthers.stdout.trim()) {
    for (const p of lsOthers.stdout.trim().split(/\r?\n/)) {
      if (p.endsWith(".md")) warn(`untracked doc (never committed): ${p}`);
    }
  }

  // 5. Catalog integrity.
  const indexMd = await readFile(join(DOCS, "index.md"), "utf8");
  const lsTracked = spawnSync("git", ["ls-files", "docs"], { cwd: ROOT, encoding: "utf8" });
  const tracked = new Set((lsTracked.status === 0 ? lsTracked.stdout : "").trim().split(/\r?\n/).filter(Boolean));
  for (const file of docFiles) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (rel === "docs/index.md") continue;
    const base = basename(file, ".md");
    if (indexMd.includes(base)) continue;
    if (tracked.has(rel)) {
      warn(`not referenced in index.md catalog: ${rel}`);
    }
  }
  for (const line of indexMd.split(/\r?\n/)) {
    if (!/^\s*-\s/.test(line)) continue;
    const seen = new Set();
    for (const link of extractWikilinks(line)) {
      const b = basename(link);
      if (seen.has(b)) error(`duplicate wikilink [[${b}]] on one line in index.md`);
      seen.add(b);
    }
  }

  // 6. #T id collisions.
  const tasksMd = await readFile(join(DOCS, "tasks.md"), "utf8").catch(() => "");
  const tCounts = new Map();
  for (const line of tasksMd.split(/\r?\n/)) {
    const m = line.match(/^- \[ \][^#]*#T(\d+)/);
    if (m) tCounts.set(m[1], (tCounts.get(m[1]) || 0) + 1);
  }
  for (const [id, n] of tCounts) {
    if (n > 1) error(`#T${id} defined ${n}x in tasks.md (id collision) — renumber via scripts/next-task-id.mjs`);
  }

  // 7. Point-to-code discipline. Accepts any of the anchor labels the index
  //    generator recognizes — state files legitimately anchor on
  //    "Updated by:" (a tool) rather than "Code:" (owned paths).
  for (const file of docFiles) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (basename(file, ".md") === "README" || basename(file, ".md") === "index") continue;
    const head = (await readFile(file, "utf8")).split(/\r?\n/).slice(0, 12).join("\n");
    if (!/\*\*(?:Code|Reference for|Enforced by|Updated by|Machine-readable):\*\*/.test(head)) {
      warn(`no Code:/Reference: anchor (point-to-code discipline): ${rel}`);
    }
  }

  // 8. Decision-entry length cap.
  const MAX_DECISION_CHARS = 600;
  const decisionsMd = await readFile(join(DOCS, "decisions.md"), "utf8").catch(() => "");
  if (decisionsMd) {
    const dlines = decisionsMd.split(/\r?\n/);
    const starts = [];
    for (let i = 0; i < dlines.length; i++) {
      if (/^## D\d+\b/.test(dlines[i])) starts.push(i);
    }
    for (let s = 0; s < starts.length; s++) {
      const to = s + 1 < starts.length ? starts[s + 1] : dlines.length;
      const block = dlines.slice(starts[s], to).join("\n").trim();
      const id = (dlines[starts[s]].match(/^## (D\d+)/) || [])[1] || "D?";
      if (block.length > MAX_DECISION_CHARS) {
        error(
          `decisions.md ${id} is ${block.length} chars (cap ${MAX_DECISION_CHARS}) — keep entries a short pointer; detail belongs in the affected doc/CHANGELOG/code.`
        );
      }
    }
  }

  // 9.-11. State-file entry caps.
  const MAX_STATE_ENTRY_CHARS = 600;

  function entryBlocks(content, startRe, allowParagraphs = false) {
    const blocks = [];
    let cur = null;
    for (const line of content.split(/\r?\n/)) {
      const isBoundary =
        line.trim() === "" || /^#{1,6} /.test(line) || /^<!--/.test(line) || /^>/.test(line) || /^\|/.test(line);
      if (startRe.test(line)) {
        if (cur) blocks.push(cur);
        cur = line;
      } else if (isBoundary) {
        if (cur) blocks.push(cur);
        cur = null;
      } else if (cur !== null) {
        cur += "\n" + line;
      } else if (allowParagraphs && line.trim() !== "") {
        cur = line;
      }
    }
    if (cur) blocks.push(cur);
    return blocks;
  }

  function checkEntryCaps(rel, content, startRe, report, allowParagraphs = false) {
    for (const block of entryBlocks(content, startRe, allowParagraphs)) {
      if (block.length > MAX_STATE_ENTRY_CHARS) {
        const id = (block.match(/#T\d+|^## (S\d+)/) || [block.slice(0, 40)])[0];
        report(
          `${rel} entry "${id}" is ${block.length} chars (cap ${MAX_STATE_ENTRY_CHARS}) — condensed bullets only; detail belongs in the owning doc/CHANGELOG/code.`
        );
      }
    }
  }

  if (tasksMd) {
    checkEntryCaps("docs/tasks.md", tasksMd, /^- \[/, error);
    for (const line of tasksMd.split(/\r?\n/)) {
      if (/^- \[x\]/i.test(line)) {
        const id = (line.match(/#T\d+/) || [line.slice(0, 40)])[0];
        warn(`tasks.md lingering closed entry ${id} — sweep it (record lives in CHANGELOG/git history)`);
      }
    }
  }

  const logContent = await readFile(join(DOCS, "log.md"), "utf8").catch(() => "");
  if (logContent) {
    const llines = logContent.split(/\r?\n/);
    const starts = [];
    const sCounts = new Map();
    for (let i = 0; i < llines.length; i++) {
      if (/^## S\d+\b/.test(llines[i])) {
        starts.push(i);
        const n = llines[i].match(/^## S(\d+)\b/)[1];
        sCounts.set(n, (sCounts.get(n) || 0) + 1);
      }
    }
    for (let s = 0; s < starts.length; s++) {
      const to = s + 1 < starts.length ? starts[s + 1] : llines.length;
      const block = llines.slice(starts[s], to).join("\n").trim();
      const id = (llines[starts[s]].match(/^## (S[\d-]+)/) || [, "S?"])[1];
      if (block.length > MAX_STATE_ENTRY_CHARS) {
        error(`log.md ${id} is ${block.length} chars (cap ${MAX_STATE_ENTRY_CHARS}) — 1-2 sentences per session; detail belongs in CHANGELOG.md.`);
      }
    }
    for (const [id, n] of sCounts) {
      if (n > 1) error(`## S${id} defined ${n}x in log.md (session-id collision) — allocate via scripts/next-task-id.mjs --session`);
    }
  }

  const gapsContent = await readFile(join(DOCS, "gaps.md"), "utf8").catch(() => "");
  if (gapsContent) {
    checkEntryCaps("docs/gaps.md", gapsContent, /^- /, warn, true);
  }

  console.log(`\nDone. ${errors} error(s), ${warnings} warning(s).`);
  process.exit(errors > 0 ? 1 : 0);
}

await main();
