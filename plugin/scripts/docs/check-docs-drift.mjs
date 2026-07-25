#!/usr/bin/env node
/**
 * check-docs-drift.mjs (canonical, plugin-bundled — docs/decisions.md D010,
 * docs/tasks.md #T13)
 *
 * Lint gate for a project's docs/ folder. Flattened for a starter-sized
 * docs/ (no system/features/quality/dev/state subfolders — a project can
 * still nest topic pages; only tasks/decisions/log/gaps are assumed to be
 * single top-level files, via maple.config.json `docs.*`).
 *
 * OKF v0.1 alignment (D010): each page's preamble may be YAML frontmatter
 * (reserved: type/title/description/tags/timestamp; custom: audience/
 * authoritative_for/code/reference_for — see lib/preamble.mjs) OR the
 * legacy prose blockquote. Both are fully validated; a prose-only page
 * gets an extra WARN so migration pressure exists (VeHagita's ~65 pages
 * migrate later, #T5).
 *
 * ERRORS (block):
 *   1. A frontmatter `code` entry / legacy preamble `Code:`/`Enforced by:`
 *      path no longer exists.
 *   3. <docs.docsIndexJson> is stale vs the current preambles.
 *   3b. The generated Catalog block in <docs.index> (between
 *       `<!-- catalog:begin -->`/`<!-- catalog:end -->`) is stale vs what
 *       generate-docs-index.mjs would produce right now.
 *   5. A duplicate wikilink on one catalog/bullet line in <docs.index>.
 *   6. A #T id defined on >1 task bullet in <docs.tasks>, or an S id on >1
 *      `## S###` header in <docs.log> (use next-task-id.mjs).
 *   8. A <docs.decisions> D### entry over 600 chars.
 *   9. A <docs.tasks> entry block over 600 chars (condensed bullets only).
 *  10. A <docs.log> session entry over 600 chars.
 * WARNS (surface):
 *   2. A wikilink [[X]] that doesn't resolve to a real .md basename.
 *   2b. A relative markdown link `[x](y.md)` to an in-docs .md file that
 *       doesn't resolve (external http(s) links are ignored).
 *   4. An untracked (never-committed) doc.
 *   5b. <docs.index> has no `<!-- catalog:begin/end -->` markers yet —
 *       catalog auto-maintenance inactive.
 *   7. A doc with no anchor at all (frontmatter audience/authoritative_for/
 *      code/reference_for, or the legacy Code:/Reference for:/Enforced by:/
 *      Updated by:/Machine-readable: label).
 *   7b. A doc with NO frontmatter (legacy prose preamble) — migrate it.
 *   9b. A lingering closed `- [x]` entry in <docs.tasks> (sweep it).
 *  11. A <docs.gaps> entry over 600 chars.
 *
 * maple.config.json keys read (all optional — see lib/config.mjs for
 * defaults, which match this template's own flat docs/ layout):
 *   docs.root docs.index docs.tasks docs.decisions docs.log docs.gaps
 *   docs.docsIndexJson
 *
 * Run: node check-docs-drift.mjs
 *      node check-docs-drift.mjs --fix    (regenerates docs.docsIndexJson + the catalog)
 *
 * Exit code: 0 = clean, 1 = error found.
 */

import { readFile, readdir, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { join, relative, basename, dirname } from "node:path";
import { readDocMeta } from "./lib/preamble.mjs";
import { resolveDocsConfig, defaultRoot } from "./lib/config.mjs";
import { extractCatalogBlock } from "./lib/catalog.mjs";
import { run as generateIndex, computeIndex } from "./generate-docs-index.mjs";

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

// Strip fenced/inline code before scanning for wikilinks/links — code syntax
// legitimately uses double brackets (TOML tables, Bash `[[ -f x ]]`, etc).
function stripCode(content) {
  return content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

function extractWikilinks(content) {
  return [...stripCode(content).matchAll(/\[\[([^\]|#]+)(?:\|[^\]]*)?(?:#[^\]]*)?\]\]/g)].map((mm) => mm[1].trim());
}

// [text](path) — only relative links to an in-docs .md file are validated;
// http(s)/mailto/pure-anchor links are ignored.
function extractRelativeMdLinks(content) {
  const out = [];
  for (const m of stripCode(content).matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = m[1];
    if (/^([a-z][a-z0-9+.-]*:|#)/i.test(href)) continue; // scheme (http:, mailto:, ...) or pure anchor
    const [pathPart] = href.split("#");
    if (!pathPart.toLowerCase().endsWith(".md")) continue;
    out.push(pathPart);
  }
  return out;
}

function expandBraces(s) {
  const m = s.match(/^([^{]*)\{([^}]+)\}(.*)$/);
  if (!m) return [s];
  const [, pre, opts, post] = m;
  return opts.split(",").map((o) => `${pre}${o.trim()}${post}`);
}

// Same skip heuristic as before D010: only genuinely path-shaped anchor
// entries get existence-checked (a command string, a bare word, a glob, an
// origin/../absolute ref are all informational, not owned paths).
function isCheckablePath(cp) {
  if (cp.includes("*") || cp.startsWith("origin/") || cp.startsWith("../") || cp.startsWith("/")) return false;
  if (/[<>=\s]/.test(cp)) return false;
  if (!/[/.]/.test(cp)) return false;
  return true;
}

export async function run({ root, fix = false } = {}) {
  const ROOT = root || defaultRoot();
  const cfg = resolveDocsConfig(ROOT);

  let warnings = 0;
  let errors = 0;
  const messages = [];
  function warn(msg) {
    messages.push(`[warn] ${msg}`);
    warnings++;
  }
  function error(msg) {
    messages.push(`[error] ${msg}`);
    errors++;
  }

  const docFiles = await walkMd(cfg.root);
  messages.push(`Scanning ${docFiles.length} markdown files in ${relative(ROOT, cfg.root).replace(/\\/g, "/")}/...`);

  const basenameMap = new Map();
  for (const f of docFiles) {
    const base = basename(f, ".md");
    if (basenameMap.has(base)) {
      warn(`Duplicate basename "${base}": ${basenameMap.get(base)} AND ${f}`);
    }
    basenameMap.set(base, f);
  }

  const metaByFile = new Map();
  for (const file of docFiles) {
    metaByFile.set(file, readDocMeta(await readFile(file, "utf8")));
  }

  // 1. code/Code:/Enforced-by: paths exist.
  for (const file of docFiles) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const meta = metaByFile.get(file);
    if (/\bplanned\b|not yet implemented/i.test(meta.body.slice(0, 1500))) continue;
    for (const cp of meta.code) {
      if (!isCheckablePath(cp)) continue;
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
  const logRel = relative(ROOT, cfg.log).replace(/\\/g, "/");
  for (const file of docFiles) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (rel === logRel) continue; // historical, may reference deleted docs
    const content = await readFile(file, "utf8");
    for (const link of extractWikilinks(content)) {
      if (link.includes("/") && /\.[a-z]+$/.test(link)) continue;
      if (link.startsWith(".claude/")) continue;
      const base = basename(link);
      if (ignoredLinks.has(link) || ignoredLinks.has(base)) continue;
      if (!basenameMap.has(base)) {
        warn(`${rel}: unresolved wikilink [[${link}]]`);
      }
    }
  }

  // 2b. Relative markdown links to in-docs .md files resolve.
  for (const file of docFiles) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const content = await readFile(file, "utf8");
    for (const href of extractRelativeMdLinks(content)) {
      const target = join(dirname(file), href);
      if (!(await exists(target))) {
        warn(`${rel}: unresolved relative link (${href})`);
      }
    }
  }

  // 3. docs.docsIndexJson freshness + 3b. catalog freshness (docs/decisions.md
  // D010) — both computed from ONE pure (no-write) pass so a plain check run
  // never mutates the tree; --fix runs the real (writing) generator once
  // instead of re-deriving what it would have produced.
  const computed = await computeIndex({ root: ROOT });
  const docsIndexJsonRel = relative(ROOT, cfg.docsIndexJson).replace(/\\/g, "/");
  const indexRel = relative(ROOT, cfg.index).replace(/\\/g, "/");

  let indexJsonStale = false;
  if (!(await exists(cfg.docsIndexJson))) {
    indexJsonStale = true;
    if (!fix) error(`${docsIndexJsonRel} missing — run: node generate-docs-index.mjs`);
  } else {
    const onDisk = JSON.parse(await readFile(cfg.docsIndexJson, "utf8"));
    // Compare the `files` payload only — `generated` is a today()-stamped
    // date, not content, and would otherwise flag every day-old index stale.
    if (JSON.stringify(onDisk.files) !== JSON.stringify(computed.indexJson.files)) {
      indexJsonStale = true;
      if (!fix) error(`${docsIndexJsonRel} is stale vs the current preambles — run: node check-docs-drift.mjs --fix`);
    }
  }

  const indexMd = await readFile(cfg.index, "utf8").catch(() => null);
  let catalogStale = false;
  if (indexMd !== null) {
    const currentBlock = extractCatalogBlock(indexMd);
    if (currentBlock === null) {
      warn(`${indexRel} has no <!-- catalog:begin/end --> markers yet — catalog auto-maintenance inactive`);
    } else {
      const expectedBlock = computed.catalogItems.join("\n").trim();
      if (currentBlock !== expectedBlock) {
        catalogStale = true;
        if (!fix) error(`${indexRel} Catalog block is stale vs generated content — run: node check-docs-drift.mjs --fix`);
      }
    }
  }

  if (fix && (indexJsonStale || catalogStale)) {
    messages.push(`[fix] Regenerating ${docsIndexJsonRel} and the ${indexRel} catalog...`);
    await generateIndex({ root: ROOT });
  }

  // 4. Untracked docs.
  const docsRootRel = relative(ROOT, cfg.root).replace(/\\/g, "/");
  const lsOthers = spawnSync("git", ["ls-files", "--others", "--exclude-standard", docsRootRel], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (lsOthers.status === 0 && lsOthers.stdout.trim()) {
    for (const p of lsOthers.stdout.trim().split(/\r?\n/)) {
      if (p.endsWith(".md")) warn(`untracked doc (never committed): ${p}`);
    }
  }

  // 5. Duplicate wikilink on one bullet line in docs.index (generic safety net).
  if (indexMd !== null) {
    for (const line of indexMd.split(/\r?\n/)) {
      if (!/^\s*-\s/.test(line)) continue;
      const seen = new Set();
      for (const link of extractWikilinks(line)) {
        const b = basename(link);
        if (seen.has(b)) error(`duplicate wikilink [[${b}]] on one line in ${indexRel}`);
        seen.add(b);
      }
    }
  }

  // 6. #T id collisions.
  const tasksMd = await readFile(cfg.tasks, "utf8").catch(() => "");
  const tCounts = new Map();
  for (const line of tasksMd.split(/\r?\n/)) {
    const m = line.match(/^- \[ \][^#]*#T(\d+)/);
    if (m) tCounts.set(m[1], (tCounts.get(m[1]) || 0) + 1);
  }
  for (const [id, n] of tCounts) {
    if (n > 1) error(`#T${id} defined ${n}x in ${relative(ROOT, cfg.tasks).replace(/\\/g, "/")} (id collision) — renumber via next-task-id.mjs`);
  }

  // 7. Point-to-code discipline + 7b. frontmatter migration pressure.
  for (const file of docFiles) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    if (basename(file, ".md") === "README" || rel === indexRel) continue;
    const meta = metaByFile.get(file);
    if (!meta.hasAnyAnchor) {
      warn(`no anchor (audience/authoritative_for/code/reference_for — point-to-code discipline): ${rel}`);
    }
    if (!meta.hasFrontmatter) {
      warn(`legacy prose preamble (no OKF v0.1 frontmatter yet — see docs/decisions.md D010): ${rel}`);
    }
  }

  // 8. Decision-entry length cap.
  const MAX_DECISION_CHARS = 600;
  const decisionsRel = relative(ROOT, cfg.decisions).replace(/\\/g, "/");
  const decisionsMd = await readFile(cfg.decisions, "utf8").catch(() => "");
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
          `${decisionsRel} ${id} is ${block.length} chars (cap ${MAX_DECISION_CHARS}) — keep entries a short pointer; detail belongs in the affected doc/CHANGELOG/code.`
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

  const tasksRel = relative(ROOT, cfg.tasks).replace(/\\/g, "/");
  if (tasksMd) {
    checkEntryCaps(tasksRel, tasksMd, /^- \[/, error);
    for (const line of tasksMd.split(/\r?\n/)) {
      if (/^- \[x\]/i.test(line)) {
        const id = (line.match(/#T\d+/) || [line.slice(0, 40)])[0];
        warn(`${tasksRel} lingering closed entry ${id} — sweep it (record lives in CHANGELOG/git history)`);
      }
    }
  }

  const logContent = await readFile(cfg.log, "utf8").catch(() => "");
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
        error(`${logRel} ${id} is ${block.length} chars (cap ${MAX_STATE_ENTRY_CHARS}) — 1-2 sentences per session; detail belongs in CHANGELOG.md.`);
      }
    }
    for (const [id, n] of sCounts) {
      if (n > 1) error(`## S${id} defined ${n}x in ${logRel} (session-id collision) — allocate via next-task-id.mjs --session`);
    }
  }

  const gapsRel = relative(ROOT, cfg.gaps).replace(/\\/g, "/");
  const gapsContent = await readFile(cfg.gaps, "utf8").catch(() => "");
  if (gapsContent) {
    checkEntryCaps(gapsRel, gapsContent, /^- /, warn, true);
  }

  messages.push(`\nDone. ${errors} error(s), ${warnings} warning(s).`);
  return { errors, warnings, messages };
}

function isMain() {
  if (!process.argv[1]) return false;
  const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  return import.meta.url === argvUrl;
}

async function main() {
  const fix = process.argv.includes("--fix");
  const { errors, messages } = await run({ fix });
  for (const m of messages) {
    if (m.startsWith("[error]")) console.error(m);
    else if (m.startsWith("[warn]")) console.warn(m);
    else console.log(m);
  }
  process.exit(errors > 0 ? 1 : 0);
}

if (isMain()) {
  await main();
}
