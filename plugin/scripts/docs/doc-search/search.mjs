#!/usr/bin/env node
// search.mjs (canonical, plugin-bundled — docs/decisions.md D010,
// docs/tasks.md #T13) — BM25 chunk-level search over a project's docs/,
// powering the ask-gate hook + manual lookups. Generic BM25 over markdown
// (no project-specific logic).
//
// Live-chunks the corpus on every index build (no stored index file, so
// nothing can go stale); fast for a docs/ folder of this size. Fail-open by
// design: every consumer (hooks, manual CLI) treats any error as "no
// retrieval" and falls back to plain Read/Grep — the searcher is an
// accelerant, never a dependency.
//
// Chunking: H1-H3 heading sections everywhere; docs.tasks + docs.gaps
// additionally split per top-level bullet (one chunk per #T/gap entry).
// docs.decisions (## D###) and docs.log (## S###) are already heading-shaped.
//
// maple.config.json keys read: docs.root docs.tasks docs.gaps (see
// lib/config.mjs for defaults, matching this template's flat docs/ layout)
//
// CLI: node search.mjs "your question" [-k 6] [--json]
import { readFileSync, readdirSync } from "node:fs";
import { statSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDocsConfig, defaultRoot } from "../lib/config.mjs";

const STOP = new Set(
  ("a an and are as at be but by can do does for from has have how i if in is it its no not of on or so that the " +
    "their there they this to was we what when where which who why will with would you your").split(" "),
);

export function tokenize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, " ")
    .split(" ")
    .filter((t) => t && !STOP.has(t) && (t.length >= 3 || /\d/.test(t)));
}

function* walkMd(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkMd(p);
    else if (e.name.endsWith(".md")) yield p;
  }
}

/**
 * Resolve the project root + docs.* paths this corpus reads from.
 *
 * `root` defaults to `defaultRoot()` (CLAUDE_PROJECT_DIR or process.cwd())
 * for direct/CLI callers, but plugin/hooks/ask-gate.mjs's `bm25Signal()`
 * (#T12 hardening) now threads the payload-resolved project root through
 * explicitly on every call — `chunkDocs(ROOT)` / `buildIndex(chunks)` —
 * rather than relying on this fallback.
 */
export function resolveCorpus(root = defaultRoot()) {
  const ROOT = root;
  const cfg = resolveDocsConfig(ROOT);
  return { ROOT, DOCS: cfg.root, tasksPath: cfg.tasks, gapsPath: cfg.gaps };
}

// Cheap freshness stamp so long-lived consumers know when to re-chunk: file
// count + max mtime across the corpus.
export function corpusStamp(root) {
  const { DOCS } = resolveCorpus(root);
  let max = 0;
  let n = 0;
  for (const f of walkMd(DOCS)) {
    n++;
    const m = statSync(f).mtimeMs;
    if (m > max) max = m;
  }
  return `${n}:${max}`;
}

export function chunkDocs(root) {
  const { ROOT, DOCS, tasksPath, gapsPath } = resolveCorpus(root);
  const splitBullets = new Set([tasksPath, gapsPath]);
  const chunks = [];
  for (const file of walkMd(DOCS)) {
    const doc = relative(ROOT, file).replace(/\\/g, "/");
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const splitThisDoc = splitBullets.has(file);
    const trail = []; // active heading stack [{level, text}]
    let cur = null;
    const flush = (endLine) => {
      if (cur && cur.lines.join("\n").trim()) {
        chunks.push({
          doc,
          trail: cur.trail,
          startLine: cur.start,
          endLine,
          text: cur.lines.join("\n").trim(),
        });
      }
      cur = null;
    };
    lines.forEach((line, i) => {
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h && h[1].length <= 3) {
        flush(i);
        const level = h[1].length;
        while (trail.length && trail[trail.length - 1].level >= level) trail.pop();
        trail.push({ level, text: h[2].trim() });
        cur = { start: i + 1, trail: trail.map((t) => t.text), lines: [line] };
        return;
      }
      if (splitThisDoc && /^- /.test(line)) {
        flush(i);
        cur = { start: i + 1, trail: trail.map((t) => t.text), lines: [line] };
        return;
      }
      if (!cur) cur = { start: i + 1, trail: trail.map((t) => t.text), lines: [] };
      cur.lines.push(line);
    });
    flush(lines.length);
  }
  return chunks;
}

export function buildIndex(chunks = chunkDocs()) {
  const N = chunks.length;
  const df = new Map();
  const stats = chunks.map((c) => {
    // Field weighting: heading-trail + doc-name tokens count double — a
    // query matching a section title should beat the same words buried in
    // prose.
    const fieldTokens = tokenize(c.trail.join(" ") + " " + basename(c.doc, ".md").replace(/-/g, " "));
    const tokens = tokenize(c.text).concat(fieldTokens, fieldTokens);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { tf, len: tokens.length };
  });
  const avgdl = stats.reduce((s, d) => s + d.len, 0) / (N || 1);
  return { chunks, stats, df, N, avgdl };
}

export function search(query, k = 6, index = buildIndex()) {
  const { chunks, stats, df, N, avgdl } = index;
  const K1 = 1.2;
  const B = 0.75;
  const qTerms = [...new Set(tokenize(query))];
  return chunks
    .map((c, i) => {
      const { tf, len } = stats[i];
      let score = 0;
      for (const t of qTerms) {
        const f = tf.get(t);
        if (!f) continue;
        const n = df.get(t) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / avgdl));
      }
      return { chunk: c, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ chunk, score }) => ({
      anchor: `${chunk.doc}:${chunk.startLine}`,
      doc: chunk.doc,
      heading_trail: chunk.trail,
      lines: [chunk.startLine, chunk.endLine],
      score: Math.round(score * 100) / 100,
      text:
        chunk.text.length > 1500
          ? chunk.text.slice(0, 1500) + "\n… (truncated — open the anchor for the full section)"
          : chunk.text,
    }));
}

// Discriminative relevance signal for gating (ask-gate). Raw BM25 top-score
// does not separate on-topic from off-topic questions well — idfCoverage
// (the fraction of the query's information content present in the best
// chunk) does: off-topic questions match only corpus-common words; their
// rare terms are absent, so coverage stays low.
export function relevanceSignal(query, index = buildIndex()) {
  const { chunks, stats, df, N, avgdl } = index;
  const K1 = 1.2;
  const B = 0.75;
  const qTerms = [...new Set(tokenize(query))];
  if (!qTerms.length) return null;
  const idfOf = (t) => {
    const n = df.get(t) || 0;
    return Math.log(1 + (N - n + 0.5) / (n + 0.5));
  };
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < chunks.length; i++) {
    const { tf, len } = stats[i];
    let score = 0;
    for (const t of qTerms) {
      const f = tf.get(t);
      if (!f) continue;
      score += (idfOf(t) * f * (K1 + 1)) / (f + K1 * (1 - B + (B * len) / avgdl));
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best === -1) return { topScore: 0, idfCoverage: 0, anchor: null };
  const tf = stats[best].tf;
  let covered = 0;
  let total = 0;
  for (const t of qTerms) {
    const w = idfOf(t);
    total += w;
    if (tf.get(t)) covered += w;
  }
  return {
    topScore: Math.round(bestScore * 100) / 100,
    idfCoverage: total ? Math.round((covered / total) * 100) / 100 : 0,
    anchor: `${chunks[best].doc}:${chunks[best].startLine}`,
  };
}

// Reciprocal-rank fusion across query variants. Each variant votes
// 1/(60+rank) per chunk; the original query is always variant 0, so a
// failed/absent rewrite degrades to plain single-query BM25.
export function searchFused(queries, k = 6, index = buildIndex()) {
  const K_RRF = 60;
  const byAnchor = new Map();
  for (const q of queries) {
    search(q, Math.max(k, 10), index).forEach((r, rank) => {
      const cur = byAnchor.get(r.anchor) || { ...r, score: 0 };
      cur.score += 1 / (K_RRF + rank + 1);
      byAnchor.set(r.anchor, cur);
    });
  }
  return [...byAnchor.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => ({ ...r, score: Math.round(r.score * 1000) / 1000 }));
}

// ---- CLI ----
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const kIdx = args.indexOf("-k");
  const k = kIdx !== -1 ? Number(args[kIdx + 1]) || 6 : 6;
  const json = args.includes("--json");
  const query = args.filter((a, i) => a !== "--json" && a !== "-k" && i !== kIdx + 1).join(" ");
  if (!query) {
    console.error('usage: node search.mjs "your question" [-k 6] [--json]');
    process.exit(2);
  }
  const t0 = performance.now();
  const results = search(query, k);
  const ms = Math.round(performance.now() - t0);
  if (json) {
    console.log(JSON.stringify({ query, ms, results }, null, 1));
  } else {
    console.log(`"${query}" — top ${results.length} (${ms}ms)\n`);
    for (const r of results) {
      console.log(`[${r.score}] ${r.anchor}  §${r.heading_trail.join(" › ")}`);
      console.log(`    ${r.text.replace(/\s+/g, " ").slice(0, 160)}…\n`);
    }
  }
}
