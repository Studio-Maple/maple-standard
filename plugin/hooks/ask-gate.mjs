#!/usr/bin/env node
// PreToolUse hook for AskUserQuestion — the ASK-GATE.
// Part of the maple-standard plugin (plugin/hooks/hooks.json).
//
// Goal: stop the agent from asking the user a question whose answer ALREADY
// exists in the project's decision docs (a D### was decided, a #T### tracks
// it, a gap names it). Mirrors the "check before asking" decision-integrity
// rule, but enforces it mechanically.
//
// Mechanism (PreToolUse contract, same as deny-credential-paths.mjs):
//   exit 0            -> allow the AskUserQuestion to surface to the user
//   exit 2 + stderr   -> BLOCK it; stderr is fed back to the agent as guidance
//
// It is a SOFT NUDGE, not a wall: every block tells the agent to verify
// against the cited doc and RE-ASK if the docs are stale/ambiguous. A
// per-question nudge counter (default 2) guarantees a genuinely-needed
// question always reaches the user on a later attempt.
//
// Tiers (each cheaper tier short-circuits before the next):
//   0. kill switch / re-entrancy guard          (env)
//   0.5 MODALITY gate: an options menu with no  (pure, no IO) -> NUDGE
//      recommendation. AskUserQuestion halts the turn and makes the owner
//      arbitrate; the house style is to ask INLINE and keep working, and
//      when options genuinely branch, to contrast them and RECOMMEND one.
//      "Exactly one option is marked (Recommended)" is the one part of that
//      style a hook can check deterministically, so that is what it checks.
//   1. deny-once accounting                      (temp state file)
//   2. retrieval: any matching docs material?    (exact-ID grep + full-corpus
//      BM25 via the plugin's own bundled doc-search — falls back to the
//      line-grep signal alone if the bundled module errors) — else ALLOW
//   3. Layer A protocol gate: docs not checked?  (transcript scan) -> NUDGE
//   4. Layer C semantic judge: headless small model (only if A passed) -> NUDGE?
//
// Fail-open everywhere: any error/timeout/missing-binary -> ALLOW. A buggy
// gate must never prevent the agent from asking the user.
//
// maple.config.json keys (all optional) — CANONICAL docs.* keys per
// docs/standard-architecture.md, read via plugin/scripts/docs/lib/config.mjs
// (docs/decisions.md D002-D011, reconciled docs/tasks.md #T11/#T12 — this
// hook used to read its own invented decisionsFile/tasksFile/gapsFile/
// searchScript key set; retired, one key set now):
//   docs.decisions   default "docs/decisions.md"
//   docs.tasks       default "docs/tasks.md"
//   docs.gaps        default "docs/gaps.md"
//   docs.root        default "docs" — used only for the "docs already
//                    checked this session?" transcript heuristic (Layer A)
//
// BM25 retrieval uses the plugin's OWN bundled doc-search
// (plugin/scripts/docs/doc-search/search.mjs, #T13) directly — no project
// config key for it anymore (the old `docs.searchScript` — an optional
// project-local searcher — is retired; every project gets BM25 retrieval
// for free now). chunkDocs()/buildIndex() are called with the ROOT this
// hook already resolved from the payload (see PROJECT ROOT note below),
// not left to fall back to cwd (#T12 hardening — see doc-search/search.mjs's
// former "NOTE" comment on this, now resolved).
//
// Env config (unchanged from the template original):
//   ASK_GATE_DISABLE=1            turn the gate off entirely
//   ASK_GATE_MODALITY_DISABLE=1   turn off the modality tier only
//   ASK_GATE_JUDGE=1             (internal) marks the nested judge — forces allow
//   ASK_GATE_MODEL              judge model           (default claude-haiku-4-5)
//   ASK_GATE_MAX_NUDGES        nudges per question    (default 2)
//   ASK_GATE_MIN_CONFIDENCE    judge deny threshold   (default 0.7)
//   ASK_GATE_JUDGE_TIMEOUT_MS  headless call timeout  (default 22000)
//   ASK_GATE_COVERAGE_RELEVANT idf-coverage "relevant" threshold (default 0.5)
//   ASK_GATE_COVERAGE_STRONG   idf-coverage "strong"   threshold (default 0.75)
//
// PROJECT ROOT: resolved per-invocation from the hook payload's own `cwd`
// field (falling back to $CLAUDE_PROJECT_DIR, then process.cwd()) — NOT
// from this script's own location, which lives under the plugin's install
// directory, not the adopting project.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDocsConfig } from '../scripts/docs/lib/config.mjs';
import * as docSearch from '../scripts/docs/doc-search/search.mjs';

const DISABLED = process.env.ASK_GATE_DISABLE === '1';
const REENTRANT = process.env.ASK_GATE_JUDGE === '1';
const MODEL = process.env.ASK_GATE_MODEL || 'claude-haiku-4-5';
const MAX_NUDGES = Number(process.env.ASK_GATE_MAX_NUDGES || 2);
const MIN_CONFIDENCE = Number(process.env.ASK_GATE_MIN_CONFIDENCE || 0.7);
const JUDGE_TIMEOUT = Number(process.env.ASK_GATE_JUDGE_TIMEOUT_MS || 22000);
const MAX_EXCERPT = 8000; // chars of doc material handed to the judge
// Protocol gate has no LLM to filter, so it demands a STRONG signal: an exact
// ID match, or one line where this many distinct query terms co-occur (a real
// topic block — not common words scattered across unrelated lines).
const STRONG_LINE = Number(process.env.ASK_GATE_STRONG_LINE || 3);
const COVERAGE_RELEVANT = Number(process.env.ASK_GATE_COVERAGE_RELEVANT || 0.5);
const COVERAGE_STRONG = Number(process.env.ASK_GATE_COVERAGE_STRONG || 0.75);

const MODALITY_OFF = process.env.ASK_GATE_MODALITY_DISABLE === '1';

const TMP_NS = 'maple-ask-gate';

// Small, generic stopword set — domain terms survive and do the real
// matching work.
const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'should', 'would', 'which',
  'what', 'when', 'where', 'your', 'you', 'are', 'was', 'will', 'from', 'into',
  'have', 'has', 'had', 'not', 'but', 'can', 'use', 'using', 'used', 'want',
  'need', 'make', 'does', 'did', 'they', 'them', 'their', 'our', 'out', 'off',
  'its', 'per', 'via', 'also', 'then', 'than', 'how', 'why', 'who', 'whom',
  'option', 'options', 'recommended', 'instead', 'keep', 'add', 'new', 'set',
  'get', 'one', 'two', 'all', 'any', 'both', 'either',
]);

const DEBUG = process.env.ASK_GATE_DEBUG === '1';
const dbg = (...a) => {
  if (DEBUG) process.stderr.write(`[ask-gate] ${a.join(' ')}\n`);
};

const allow = () => process.exit(0);
const nudge = (msg) => {
  process.stderr.write(msg.endsWith('\n') ? msg : `${msg}\n`);
  process.exit(2);
};

// ---- config -----------------------------------------------------------------

// Canonical docs.* resolution (docs/standard-architecture.md, #T11/#T12) —
// resolveDocsConfig() returns every path already resolved to ABSOLUTE
// against `root`, so downstream readers use them as-is (no more re-joining
// against root with a relative path, which is what the old decisionsFile/
// tasksFile/gapsFile key set assumed).
function docsConfig(root) {
  const resolved = resolveDocsConfig(root);
  const rel = (abs) => relative(root, abs).replace(/\\/g, '/');
  return {
    docsRootRel: rel(resolved.root) || 'docs',
    DOCS: [
      { path: resolved.decisions, tag: `${rel(resolved.decisions)} (decisions — D###)` },
      { path: resolved.tasks, tag: `${rel(resolved.tasks)} (tracked work — #T###)` },
      { path: resolved.gaps, tag: `${rel(resolved.gaps)} (flagged unknowns)` },
    ],
  };
}

// ---- helpers ----------------------------------------------------------------

function questionsText(questions) {
  const parts = [];
  for (const q of questions) {
    if (q?.question) parts.push(q.question);
    if (q?.header) parts.push(q.header);
    for (const o of q?.options || []) {
      if (o?.label) parts.push(o.label);
      if (o?.description) parts.push(o.description);
    }
  }
  return parts.join('\n');
}

function hashQuestions(questions) {
  const norm = questions.map((q) => (q?.question || '').trim().toLowerCase()).join('|');
  return createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

function extractTerms(text) {
  const lc = text.toLowerCase();
  const ids = new Set();
  for (const m of text.matchAll(/#?\b([TD]\d{2,}(?:-[a-z0-9]+)?)\b/gi)) {
    ids.add(m[1].toLowerCase());
  }
  const words = new Set();
  for (const m of lc.matchAll(/[a-z][a-z0-9.\-]{3,}/g)) {
    const w = m[0];
    if (!STOP.has(w)) words.add(w);
  }
  return { ids: [...ids], words: [...words].slice(0, 30) };
}

function loadDoc(absPath) {
  try {
    return readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
}

function retrieve(docs, terms) {
  const records = [];
  let idMatch = false;
  for (const { path } of docs) {
    const content = loadDoc(path);
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lc = line.toLowerCase();
      let score = 0;
      for (const id of terms.ids) {
        if (lc.includes(id)) { score += 3; idMatch = true; }
      }
      for (const w of terms.words) {
        if (lc.includes(w)) score += 1;
      }
      if (score > 0) {
        records.push({ path, line: i + 1, text: line.trim(), score });
      }
    }
  }
  records.sort((a, b) => b.score - a.score);

  let excerpt = '';
  const chosen = [];
  for (const r of records) {
    const row = `${r.path.split('/').pop()}:${r.line}: ${r.text}\n`;
    if (excerpt.length + row.length > MAX_EXCERPT) break;
    excerpt += row;
    chosen.push(r);
  }
  const hitDocs = [...new Set(chosen.map((r) => r.path.split('/').pop()))];
  return { hitCount: records.length, idMatch, excerpt, hitDocs };
}

// Full-corpus BM25 signal via the plugin's own BUNDLED doc-search
// (plugin/scripts/docs/doc-search/search.mjs, #T13) — statically imported
// above, so this always runs (no more "optional project-local script,
// absent for most adopters"). `root` is the SAME project root this hook
// already resolved from the payload (see main()) and is threaded all the
// way through to chunkDocs()/buildIndex() — fixes the #T12-flagged gap
// where this used to call buildIndex() with no root, leaving it to fall
// back to CLAUDE_PROJECT_DIR/cwd instead of the payload-resolved root.
async function bm25Signal(root, text) {
  try {
    const chunks = docSearch.chunkDocs(root);
    const index = docSearch.buildIndex(chunks);
    const sig = docSearch.relevanceSignal(text, index);
    if (!sig) return null;
    const top = docSearch.search(text, 6, index);
    let excerpt = '';
    const hitDocs = [];
    for (const r of top) {
      const row = `${r.anchor} §${r.heading_trail.join(' > ')}\n${r.text}\n---\n`;
      if (excerpt.length + row.length > MAX_EXCERPT) break;
      excerpt += row;
      const base = r.doc.split('/').pop();
      if (!hitDocs.includes(base)) hitDocs.push(base);
    }
    return { ...sig, excerpt, hitDocs };
  } catch {
    return null;
  }
}

function docsCheckedInSession(transcriptPath, docsRoot) {
  if (!transcriptPath) return false;
  let raw = '';
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return false;
  }
  const escapedRoot = docsRoot.replace(/[/\\]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sigil = new RegExp(`(decisions|tasks|gaps)\\.md|(^|[/\\\\])${escapedRoot}([/\\\\]|$)`, 'i');
  for (const line of raw.split('\n')) {
    if (!line.includes('tool_use')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const uses = collectToolUses(obj);
    for (const u of uses) {
      if (sigil.test(JSON.stringify(u.input || {}))) return true;
    }
  }
  return false;
}

function collectToolUses(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (node.type === 'tool_use') acc.push(node);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((x) => collectToolUses(x, acc));
    else if (v && typeof v === 'object') collectToolUses(v, acc);
  }
  return acc;
}

// ---- Tier 0.5: modality -----------------------------------------------------

// The owner's standing instruction: AskUserQuestion stops the turn and makes
// him click, so it is the EXCEPTION, not the default. Ask inline, in prose,
// and keep working on everything that doesn't depend on the answer. When a
// decision genuinely branches, contrast the options and recommend one —
// never hand over a neutral menu to arbitrate.
//
// Only the last clause is mechanically checkable, so that is the gate:
// a question that offers options must mark EXACTLY ONE "(Recommended)".
// Zero marks = a neutral menu. Two or more = not a recommendation.
//
// Pure and IO-free, so it runs before any doc retrieval. Fires at most once
// per distinct question set (its own budget, separate from MAX_NUDGES) — it
// is a style nudge and must never wall off a question the owner needs.
function modalityFindings(questions) {
  const bad = [];
  for (const q of questions) {
    const opts = (q?.options || []).filter((o) => o && o.label);
    if (opts.length === 0) continue; // a bare question is already the good shape
    const marked = opts.filter((o) => /\(\s*recommended\s*\)/i.test(o.label));
    if (marked.length !== 1) {
      bad.push({
        header: q?.header || q?.question || '(question)',
        count: opts.length,
        marked: marked.length,
      });
    }
  }
  return bad;
}

function modalityNudge(questions, sessionId, hash) {
  if (MODALITY_OFF) return null;
  const bad = modalityFindings(questions);
  if (bad.length === 0) return null;

  const key = `${hash}:modality`;
  if ((readNudges(sessionId)[key] || 0) >= 1) return null; // once, then get out of the way
  bumpNudges(sessionId, key);

  const rows = bad
    .map((b) => `    - "${b.header}": ${b.count} options, ${b.marked} marked (Recommended)`)
    .join('\n');

  return [
    'ASK-GATE (modality): is AskUserQuestion really the right way to ask this ' +
      'right now? It stops the turn and makes the owner arbitrate a menu.',
    "  House style — ask INLINE, in prose, and keep working on everything that " +
      "doesn't depend on the answer.",
    "    - Obvious, or has a sane default? Don't ask. Pick it, say so, continue.",
    '    - A plain question? Ask it in one line inline.',
    '    - Genuinely branching? Then contrast the options against each other and ' +
      'RECOMMEND one — mark it "(Recommended)".',
    '  Neutral menus found:',
    rows,
    '  Re-ask if this really is a branching decision and you have a ' +
      'recommendation to mark — this gate allows the re-ask.',
  ].join('\n');
}

// ---- deny-once state (best-effort; lives in OS temp, never the repo) --------

function statePath(sessionId) {
  const dir = join(tmpdir(), TMP_NS);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return join(dir, `${(sessionId || 'default').replace(/[^a-z0-9._-]/gi, '_')}.json`);
}

function readNudges(sessionId) {
  try {
    return JSON.parse(readFileSync(statePath(sessionId), 'utf8')) || {};
  } catch {
    return {};
  }
}

function bumpNudges(sessionId, hash) {
  try {
    const s = readNudges(sessionId);
    s[hash] = (s[hash] || 0) + 1;
    writeFileSync(statePath(sessionId), JSON.stringify(s));
  } catch {
    /* state is best-effort — a write failure just means we might nudge again */
  }
}

// ---- Layer C: headless semantic judge --------------------------------------

function runJudge(questions, excerpt) {
  const asks = questions
    .map((q) => {
      const opts = (q.options || []).map((o) => o.label).filter(Boolean).join(' | ');
      return `- ${q.question}${opts ? ` [options: ${opts}]` : ''}`;
    })
    .join('\n');

  const prompt = `You are a pure text classifier. Your ONLY job is to output one JSON object. Do NOT ask for clarification, do NOT use tools, do NOT explain — output JSON and stop.

An agent is about to ask its USER the question(s) below. Using ONLY the doc excerpts provided, decide whether those docs ALREADY answer the question, making it unnecessary to ask.

Output EXACTLY one JSON object, no prose, no markdown fences:
{"answered": <boolean>, "answer": "<concise resolved answer if answered, else empty>", "citation": "<doc filename + D###/#T### id if any, else empty>", "confidence": <0..1>}

Rules:
- answered=true ONLY if the excerpts clearly and directly resolve the question.
- If the excerpts are merely related but do not decide the matter, OR are insufficient, answered=false.
- Be conservative; when unsure, answered=false with low confidence.

QUESTION(S) THE AGENT WANTS TO ASK:
${asks}

DOC EXCERPTS (filename:line: text):
${excerpt}`;

  // Run from an empty scratch dir so the nested CLI call does NOT load this
  // project's CLAUDE.md / settings — that would bias it toward project-agent
  // behaviour (and re-register this very hook).
  const scratch = join(tmpdir(), TMP_NS);
  try {
    mkdirSync(scratch, { recursive: true });
  } catch {
    /* ignore */
  }

  let res;
  try {
    res = spawnSync(
      'claude',
      ['-p', '--model', MODEL, '--output-format', 'json', '--strict-mcp-config'],
      {
        input: prompt,
        cwd: scratch,
        encoding: 'utf8',
        timeout: JUDGE_TIMEOUT,
        maxBuffer: 4 * 1024 * 1024,
        shell: true, // resolve claude/claude.cmd via PATH; all argv tokens are quote-free
        env: { ...process.env, ASK_GATE_JUDGE: '1' },
      }
    );
  } catch {
    return null;
  }
  if (!res || res.status !== 0 || !res.stdout) {
    dbg('judge spawn failed: status=', String(res?.status), 'err=', String(res?.error || ''), 'stderr=', (res?.stderr || '').slice(0, 200));
    return null;
  }

  let modelText = res.stdout;
  try {
    const outer = JSON.parse(res.stdout);
    if (typeof outer?.result === 'string') modelText = outer.result;
  } catch {
    /* fall through and try to parse stdout directly */
  }
  dbg('judge raw result:', modelText.slice(0, 300).replace(/\n/g, ' '));
  const m = modelText.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

// ---- main -------------------------------------------------------------------

async function main(raw) {
  if (DISABLED || REENTRANT) return allow();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return allow();
  }

  const questions = payload?.tool_input?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return allow();

  const ROOT = payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const { DOCS, docsRootRel } = docsConfig(ROOT);

  const sessionId = payload?.session_id || 'default';
  const transcriptPath = payload?.transcript_path || '';
  const hash = hashQuestions(questions);

  const modality = modalityNudge(questions, sessionId, hash);
  if (modality) return nudge(modality);

  if ((readNudges(sessionId)[hash] || 0) >= MAX_NUDGES) return allow();

  const qText = questionsText(questions);
  const terms = extractTerms(qText);
  const hit = retrieve(DOCS, terms);
  const bm = await bm25Signal(ROOT, qText);
  const relevant = hit.idMatch || (bm ? bm.idfCoverage >= COVERAGE_RELEVANT : hit.hitCount >= 2);
  dbg('hitCount=', String(hit.hitCount), 'idMatch=', String(hit.idMatch),
    'idfCoverage=', String(bm?.idfCoverage ?? 'n/a'), 'bmAnchor=', String(bm?.anchor ?? 'n/a'));
  if (!relevant) return allow(); // docs say nothing about this — ask freely.

  const checked = docsCheckedInSession(transcriptPath, docsRootRel);
  dbg('checked=', String(checked));

  const strong = hit.idMatch || (bm ? bm.idfCoverage >= COVERAGE_STRONG : hit.hitCount >= STRONG_LINE);
  if (!checked && strong) {
    bumpNudges(sessionId, hash);
    const kw = [...terms.ids, ...terms.words].slice(0, 12).join(', ');
    const where = bm?.hitDocs?.length ? bm.hitDocs : hit.hitDocs;
    return nudge(
      `ASK-GATE (protocol): before asking the user, check the docs — ` +
        `this session hasn't read them yet and they contain matching material ` +
        `(${where.join(', ')}).\n` +
        `  Grep or read the docs for: ${kw}\n` +
        DOCS.map((d) => `    - ${d.tag}`).join('\n') +
        `\n  If the answer is there, act on it and CITE it instead of asking. ` +
        `If it's genuinely unresolved after checking, ask again — this gate allows the re-ask.`
    );
  }

  if (!checked) return allow();

  const verdict = runJudge(questions, bm?.excerpt || hit.excerpt);
  if (verdict?.answered && Number(verdict.confidence) >= MIN_CONFIDENCE) {
    bumpNudges(sessionId, hash);
    return nudge(
      `ASK-GATE (already-answered, confidence ${verdict.confidence}): the project ` +
        `docs appear to already resolve this.\n` +
        `  ANSWER: ${verdict.answer || '(see source)'}\n` +
        `  SOURCE: ${verdict.citation || hit.hitDocs.join(', ')}\n` +
        `  Verify against the cited doc; if correct, act on it and CITE it instead ` +
        `of asking. If the docs are actually stale/ambiguous, ask again — this gate ` +
        `allows the re-ask.`
    );
  }

  return allow();
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
});
process.stdin.on('end', () => {
  // fail-open: a hook bug must never block the question
  main(buf).catch(() => process.exit(0));
});
