/**
 * Deterministic duplicate-candidate detection for tools/jev/audit.mjs.
 *
 * Jev is asked to CONFIRM a duplicate, never to FIND one — finding is a
 * token-shingle overlap computed locally, which is exact, free, and runs
 * over every extracted function including ones that will never be sent to
 * Jev (denylisted or out-of-scope), since comparing against them is how an
 * in-scope function's duplicate of a sensitive/out-of-scope one gets caught
 * at all. What never happens is sending a denylisted function's SOURCE
 * anywhere — that filtering happens where pairs are turned into Jev calls
 * (see selectPairsForJev), not here.
 *
 * Candidate generation is an inverted index (shingle -> function ids), not a
 * full O(n^2) comparison: with ~1-2k functions in this repo a pairwise
 * Jaccard over everything is wasteful when the overwhelming majority share
 * no shingles at all. This is "winnowing" in spirit (only compare things
 * that already look alike) without the fixed-window minimizer selection a
 * textbook winnowing implementation would add — traded for simplicity, since
 * whole-shingle-set overlap is already cheap once indexed.
 */

/** Env-overridable, per the house style (see judge.mjs/supervise.mjs) — these are the two an owner will most want to retune after seeing real duplicate pairs. */
export const JACCARD_THRESHOLD = Number(process.env.MAPLE_QUALITY_AUDIT_JACCARD_THRESHOLD || 0.6);
export const JEV_PAIR_CAP = Number(process.env.MAPLE_QUALITY_AUDIT_DUP_PAIR_CAP || 200);

const KEYWORDS = new Set([
  "function", "const", "let", "var", "return", "if", "else", "for", "while", "do", "switch", "case",
  "break", "continue", "new", "this", "class", "extends", "import", "export", "default", "async",
  "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "null", "undefined",
  "true", "false", "void", "yield", "static", "get", "set", "public", "private", "protected", "readonly",
  "interface", "type", "enum", "namespace", "declare", "from", "as", "implements", "super",
]);

const TOKEN_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\d+(?:\.\d+)?|[A-Za-z_$][A-Za-z0-9_$]*|[{}()[\];,.:?<>=+\-*/%!&|^~]/g;

export function tokenize(source) {
  return source.match(TOKEN_RE) ?? [];
}

/**
 * Canonicalize so that renaming a variable, or changing a literal's value,
 * doesn't hide a structural duplicate: identifiers collapse to `ID` (unless
 * a reserved word), string/number literals collapse to `LIT`.
 */
export function canonicalizeTokens(tokens) {
  return tokens.map((tok) => {
    if (/^["'`]/.test(tok)) return "LIT_STR";
    if (/^\d/.test(tok)) return "LIT_NUM";
    if (/^[A-Za-z_$]/.test(tok)) return KEYWORDS.has(tok) ? tok : "ID";
    return tok;
  });
}

export function shinglesOf(tokens, k) {
  const set = new Set();
  for (let i = 0; i + k <= tokens.length; i++) set.add(tokens.slice(i, i + k).join(" "));
  return set;
}

export function fingerprintOf(source, shingleSize = 5) {
  return shinglesOf(canonicalizeTokens(tokenize(source)), shingleSize);
}

export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const x of small) if (large.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * @param {Array<{id:string, source:string}>} functions  ALL extracted functions, in and out of scope
 * @param {{shingleSize?:number, threshold?:number}} [opts]
 * @returns {Array<{aId:string, bId:string, jaccard:number}>} sorted worst(most similar)-first
 */
export function findCandidatePairs(functions, opts = {}) {
  const shingleSize = opts.shingleSize ?? 5;
  const threshold = opts.threshold ?? JACCARD_THRESHOLD;

  const fingerprints = new Map();
  for (const fn of functions) {
    const fp = fingerprintOf(fn.source, shingleSize);
    if (fp.size > 0) fingerprints.set(fn.id, fp);
  }

  const index = new Map(); // shingle -> [ids]
  for (const [id, set] of fingerprints) {
    for (const shingle of set) {
      let list = index.get(shingle);
      if (!list) {
        list = [];
        index.set(shingle, list);
      }
      list.push(id);
    }
  }

  const candidateKeys = new Set();
  for (const list of index.values()) {
    // A shingle shared by 50+ functions is boilerplate (an empty catch block,
    // a one-line re-export) rather than a meaningful duplicate signal, and
    // pairing all of them is O(n^2) for zero benefit — skip it.
    if (list.length < 2 || list.length > 50) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        candidateKeys.add(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
      }
    }
  }

  const pairs = [];
  for (const key of candidateKeys) {
    const [a, b] = key.split("\u0000");
    const j = jaccard(fingerprints.get(a), fingerprints.get(b));
    if (j >= threshold) pairs.push({ aId: a, bId: b, jaccard: j });
  }
  pairs.sort((x, y) => y.jaccard - x.jaccard);
  return pairs;
}

// ── exact-duplicate clustering ──────────────────────────────────────────────
//
// The MapleLens pilot run showed `jsonResponse` copy-pasted into ~16 route
// files, burning ~120 of the 200 Jev pair slots on pairs that were not near-
// duplicates needing a judgment call — they were byte-for-byte identical
// after comment/whitespace stripping (same `bodyHash`, see audit-extract.mjs
// `normalizeBody`/`bodyHash`). That is a DEFINITIONAL fact, not something Jev
// needs to confirm: grouping by bodyHash finds every such cluster for free,
// locally, before a single Jev pair call is made.

/** @returns {Map<string, string[]>} bodyHash -> function ids sharing that exact normalized body */
export function groupByBodyHash(functions) {
  const groups = new Map();
  for (const fn of functions) {
    if (!fn.bodyHash) continue;
    let list = groups.get(fn.bodyHash);
    if (!list) groups.set(fn.bodyHash, (list = []));
    list.push(fn.id);
  }
  return groups;
}

/**
 * Every group of 2+ functions sharing a bodyHash is a CONFIRMED exact
 * duplicate: probability 1, source "deterministic" — never sent to Jev.
 * Reported as one cluster with all its members, not an O(n^2) pair list.
 *
 * @param {Array<{id:string, bodyHash:string}>} functions
 * @param {{inScopeIds?: Set<string>}} [opts]  when given, a cluster is only reported if at least one member is in-scope (mirrors selectPairsForJev's rule for near-duplicate pairs)
 * @returns {Array<{bodyHash:string, memberIds:string[], probability:1, source:'deterministic'}>} sorted largest-cluster-first
 */
export function findExactDuplicateClusters(functions, { inScopeIds } = {}) {
  const clusters = [];
  for (const [hash, ids] of groupByBodyHash(functions)) {
    if (ids.length < 2) continue;
    if (inScopeIds && !ids.some((id) => inScopeIds.has(id))) continue;
    clusters.push({ bodyHash: hash, memberIds: ids.slice().sort(), probability: 1, source: "deterministic" });
  }
  clusters.sort((a, b) => b.memberIds.length - a.memberIds.length);
  return clusters;
}

/**
 * Filters `findCandidatePairs`' output down to the pairs actually worth a
 * Jev "same job?" call: exact-duplicate pairs are dropped outright (already
 * captured as a cluster above, probability 1, no judgment needed), and every
 * remaining pair is deduplicated BY CLUSTER — at most one representative pair
 * per (exact-duplicate-cluster, exact-duplicate-cluster) combination, since
 * every member of one cluster is byte-identical to every other member, so
 * asking Jev about more than one cross-cluster pair is a wasted call. A
 * function with a unique body (bodyHash shared by nobody else) is its own
 * one-member cluster, so this is a no-op for the common case. Order is
 * preserved (candidatePairs arrives sorted worst/most-similar-first), so the
 * pair kept per cluster combination is always the highest-Jaccard one.
 *
 * @param {Array<{aId:string, bId:string, jaccard:number}>} candidatePairs
 * @param {Map<string, {id:string, bodyHash:string}>} byId
 */
export function dedupeNearDuplicatePairs(candidatePairs, byId) {
  const seen = new Set();
  const deduped = [];
  for (const pair of candidatePairs) {
    const a = byId.get(pair.aId);
    const b = byId.get(pair.bId);
    if (!a || !b) continue;
    if (a.bodyHash === b.bodyHash) continue; // exact duplicate — reported as a cluster, never asked of Jev
    const key = a.bodyHash < b.bodyHash ? `${a.bodyHash}\u0000${b.bodyHash}` : `${b.bodyHash}\u0000${a.bodyHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(pair);
  }
  return deduped;
}

/**
 * Turn candidate pairs into "safe to send to Jev" pairs: at least one side
 * in scope, neither side denylisted (source never leaves the machine for a
 * sensitive function, full stop — even to confirm a duplicate), capped so a
 * pathological repo can't produce an unbounded bill. Candidates should
 * already be run through `dedupeNearDuplicatePairs` first — this function
 * itself only enforces scope/denylist/cap, not clustering.
 *
 * @returns {{pairs: Array, droppedForCap: number, droppedForDenylist: number}}
 */
/**
 * Cache key for a confirmed duplicate-pair verdict, keyed by both sides'
 * BODY HASHES (not their ids) so a rename/move of either function still hits
 * the cache, and a pair is cached the same way regardless of which side was
 * passed as `a` vs `b`.
 */
export function dupCacheKey(bodyHashA, bodyHashB) {
  return bodyHashA < bodyHashB ? `${bodyHashA}\u0000${bodyHashB}` : `${bodyHashB}\u0000${bodyHashA}`;
}

export function selectPairsForJev(candidatePairs, { inScopeIds, isDenylistedId, cap = JEV_PAIR_CAP }) {
  let droppedForDenylist = 0;
  const eligible = [];
  for (const pair of candidatePairs) {
    if (isDenylistedId(pair.aId) || isDenylistedId(pair.bId)) {
      droppedForDenylist++;
      continue;
    }
    if (!inScopeIds.has(pair.aId) && !inScopeIds.has(pair.bId)) continue;
    eligible.push(pair);
  }
  const pairs = eligible.slice(0, cap);
  return { pairs, droppedForCap: Math.max(0, eligible.length - cap), droppedForDenylist };
}
