#!/usr/bin/env node
// PreToolUse hook for AskUserQuestion — the ASK-GATE.
//
// Goal: stop the agent from asking the user a question whose answer ALREADY
// exists in the project's decision docs (a D### was decided, a #T### tracks
// it, a gap names it). Mirrors CLAUDE.md's "Decision integrity" rule
// ("check first"), but enforces it mechanically. Docs paths follow this
// template's flat docs/ layout; the fail-open judge model is env-overridable.
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
//   1. deny-once accounting                      (temp state file)
//   2. retrieval: any matching docs material?    (exact-ID grep + full-corpus
//      BM25 idf-coverage via scripts/doc-search; falls back to a legacy
//      keyword line-grep if the searcher errors) — else ALLOW
//   3. Layer A protocol gate: docs not checked?  (transcript scan) -> NUDGE
//   4. Layer C semantic judge: headless small model (only if A passed) -> NUDGE?
//
// Fail-open everywhere: any error/timeout/missing-binary -> ALLOW. A buggy
// gate must never prevent the agent from asking the user.
//
// Config (all env-overridable):
//   ASK_GATE_DISABLE=1            turn the gate off entirely
//   ASK_GATE_JUDGE=1             (internal) marks the nested judge — forces allow
//   ASK_GATE_MODEL              judge model           (default claude-haiku-4-5)
//   ASK_GATE_MAX_NUDGES        nudges per question    (default 2)
//   ASK_GATE_MIN_CONFIDENCE    judge deny threshold   (default 0.7)
//   ASK_GATE_JUDGE_TIMEOUT_MS  headless call timeout  (default 22000)
//   ASK_GATE_COVERAGE_RELEVANT idf-coverage "relevant" threshold (default 0.5)
//   ASK_GATE_COVERAGE_STRONG   idf-coverage "strong"   threshold (default 0.75)
//
// Registered in .claude/settings.json under hooks.PreToolUse (matcher
// "AskUserQuestion", timeout 30s to accommodate the model call).

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..'); // repo root, from .claude/hooks/

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

const DOCS = [
  { path: 'docs/decisions.md', tag: 'decisions.md (decisions — D###)' },
  { path: 'docs/tasks.md', tag: 'tasks.md (tracked work — #T###)' },
  { path: 'docs/gaps.md', tag: 'gaps.md (flagged unknowns)' },
];

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

function loadDoc(rel) {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
}

function retrieve(terms) {
  const records = [];
  let idMatch = false;
  for (const { path } of DOCS) {
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
  const maxScore = records.length ? records[0].score : 0;

  let excerpt = '';
  const chosen = [];
  for (const r of records) {
    const row = `${r.path.split('/').pop()}:${r.line}: ${r.text}\n`;
    if (excerpt.length + row.length > MAX_EXCERPT) break;
    excerpt += row;
    chosen.push(r);
  }
  const hitDocs = [...new Set(chosen.map((r) => r.path.split('/').pop()))];
  return { hitCount: records.length, idMatch, maxScore, excerpt, hitDocs };
}

// Full-corpus BM25 signal via scripts/doc-search. idfCoverage gates on
// DISCRIMINATIVE terms: corpus-common words carry ~zero weight, so a
// homonym overlap can't trip the gate the way the line-grep could.
async function bm25Signal(text) {
  try {
    const mod = await import('../../scripts/doc-search/search.mjs');
    const index = mod.buildIndex();
    const sig = mod.relevanceSignal(text, index);
    if (!sig) return null;
    const top = mod.search(text, 6, index);
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

function docsCheckedInSession(transcriptPath) {
  if (!transcriptPath) return false;
  let raw = '';
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return false;
  }
  const sigil = /(decisions|tasks|gaps)\.md|(^|[/\\])docs([/\\]|$)/i;
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

// ---- deny-once state (best-effort; lives in OS temp, never the repo) --------

function statePath(sessionId) {
  const dir = join(tmpdir(), 'maple-standard-ask-gate');
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
  // project's CLAUDE.md / .claude/settings.json — that would bias it toward
  // project-agent behaviour (and re-register this very hook).
  const scratch = join(tmpdir(), 'maple-standard-ask-gate');
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

  const sessionId = payload?.session_id || 'default';
  const transcriptPath = payload?.transcript_path || '';
  const hash = hashQuestions(questions);

  if ((readNudges(sessionId)[hash] || 0) >= MAX_NUDGES) return allow();

  const qText = questionsText(questions);
  const terms = extractTerms(qText);
  const hit = retrieve(terms);
  const bm = await bm25Signal(qText);
  const relevant = hit.idMatch || (bm ? bm.idfCoverage >= COVERAGE_RELEVANT : hit.hitCount >= 2);
  dbg('hitCount=', String(hit.hitCount), 'idMatch=', String(hit.idMatch), 'maxScore=', String(hit.maxScore),
    'idfCoverage=', String(bm?.idfCoverage ?? 'n/a'), 'bmAnchor=', String(bm?.anchor ?? 'n/a'));
  if (!relevant) return allow(); // docs say nothing about this — ask freely.

  const checked = docsCheckedInSession(transcriptPath);
  dbg('checked=', String(checked));

  const strong = hit.idMatch || (bm ? bm.idfCoverage >= COVERAGE_STRONG : hit.maxScore >= STRONG_LINE);
  if (!checked && strong) {
    bumpNudges(sessionId, hash);
    const kw = [...terms.ids, ...terms.words].slice(0, 12).join(', ');
    const where = bm?.hitDocs?.length ? bm.hitDocs : hit.hitDocs;
    return nudge(
      `ASK-GATE (protocol): before asking the user, check the docs — ` +
        `this session hasn't read them yet and they contain matching material ` +
        `(${where.join(', ')}).\n` +
        `  Grep or read the docs for: ${kw}\n` +
        DOCS.map((d) => `    - ${d.path}  — ${d.tag}`).join('\n') +
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
