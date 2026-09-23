/**
 * Function extraction for tools/jev/audit.mjs.
 *
 * Walks the TypeScript compiler API's AST (the repo's own `typescript`
 * dependency — no new parsing package) to pull out every function-shaped
 * declaration worth judging: function declarations, class methods, and
 * arrow/function expressions assigned to a name (including React components,
 * which in this codebase are just capitalized functions returning JSX — no
 * separate detection is needed beyond "it's a function").
 *
 * This module is pure and file-system-light by design: `extractFromSource`
 * takes text already in memory so it is trivial to unit-test against fixture
 * strings, with no repo checkout required. `discoverFiles` is the only part
 * that shells out to git, and it is a thin wrapper the CLI can swap out.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ts from "typescript";

const execFileAsync = promisify(execFile);

// ── glob matching (no new dependency — the patterns here are simple enough
// that a hand-rolled glob-to-regex beats pulling in micromatch/minimatch) ──

/**
 * Convert a small glob subset (`*`, `**`, `?`, literal segments) to a RegExp
 * anchored to the whole string. Good enough for the exclude/scope globs this
 * file ever sees; it is not a general-purpose glob engine.
 */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        // Swallow an immediately-following slash so `**/foo` also matches `foo`.
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Normalize to forward slashes so globs written with `/` work on Windows paths too. */
export function toPosix(p) {
  return p.replace(/\\/g, "/");
}

export function matchesAnyGlob(relPath, globs) {
  const posix = toPosix(relPath);
  return globs.some((g) => globToRegExp(g).test(posix));
}

// ── denylist ──────────────────────────────────────────────────────────────

/**
 * @param {{denylistPatterns: string[], denylistFiles: string[], denylistDirs?: string[]}} config
 * @returns {(relPath: string, functionName: string) => boolean}
 */
export function makeDenylistTest(config) {
  const patterns = config.denylistPatterns.map((p) => new RegExp(p, "i"));
  const files = new Set((config.denylistFiles ?? []).map(toPosix));
  const dirs = (config.denylistDirs ?? []).map(toPosix);
  return function isDenylisted(relPath, functionName) {
    const posix = toPosix(relPath);
    if (files.has(posix)) return true;
    if (dirs.some((d) => posix === d || posix.startsWith(`${d}/`))) return true;
    return patterns.some((re) => re.test(posix) || re.test(functionName));
  };
}

// ── normalization / hashing ──────────────────────────────────────────────

/**
 * Strip comments and collapse whitespace so that reformatting (or adding a
 * comment) doesn't count as a "changed" function, but real edits do. This is
 * intentionally crude (no lexer) — a `//` inside a string literal can be
 * mis-stripped — traded for zero extra dependencies and "good enough to key
 * a cache", not "a faithful re-lexer".
 */
export function normalizeBody(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function bodyHash(source) {
  return createHash("sha256").update(normalizeBody(source)).digest("hex");
}

// ── deliberate best-effort catch detection ──────────────────────────────────

/**
 * Find the substring from an opening `{` at `openIndex` through its matching
 * `}`, tracking string/template/comment state well enough not to be fooled by
 * a brace inside a string literal or a comment. Returns null if unbalanced
 * (truncated source, parse edge case) — callers treat that as "can't tell,
 * don't flag it".
 */
function balancedBlock(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return source.slice(openIndex, i + 1);
    } else if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 1;
    } else if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i++;
        i++;
      }
    }
  }
  return null;
}

const CATCH_RE = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
const HAS_COMMENT_RE = /\/\/[^\n]*\S|\/\*[\s\S]*?\*\//;
const HAS_NONEMPTY_RETURN_RE = /\breturn\s+[^;\s][^;\n]*/;

// ── gate escape hatch: `// jev-audit: accept <rule> — <reason>` ────────────
//
// Plugin-only addition (the MapleLens audit this was ported from has no
// blocking gate, so no escape hatch): a rule name matching one of the
// gate's blocking rule ids, immediately followed by a dash/em-dash and a
// reason, suppresses THAT rule for THIS function. Visible in code review
// (it's a comment on the function, not a CLI flag), and the gate always
// lists every suppression it honoured — see plugin/scripts/jev/audit/gate.mjs.
const SUPPRESSION_RE = /\/\/\s*jev-audit:\s*accept\s+([a-z-]+)\s*(?:—|--|-)\s*(.+)/gi;

/**
 * @param {string} annotationSource  leading comment(s) + the function's own source, concatenated
 * @returns {Record<string,string>} rule id -> reason, for every accepted suppression found
 */
export function parseSuppressions(annotationSource) {
  const out = {};
  SUPPRESSION_RE.lastIndex = 0;
  let match;
  while ((match = SUPPRESSION_RE.exec(annotationSource))) {
    const rule = match[1].trim().toLowerCase();
    const reason = match[2].trim();
    out[rule] = reason;
  }
  return out;
}

/**
 * Cheap, deterministic pre-check (no Jev call) for whether a function
 * contains at least one catch block that reads as a DELIBERATE best-effort
 * swallow, as opposed to an error that was simply forgotten: either the catch
 * body carries an explanatory comment, or it returns an explicit fallback
 * value rather than falling through silently. Such a catch shouldn't cost the
 * function an error_handling penalty in `computeSeverity` (see
 * audit-questions.mjs) — a swallow with a documented reason is a design
 * choice, not an oversight — but the function is still surfaced separately in
 * the report so the exemption is visible, not silent.
 *
 * Regex/brace-counting rather than a full AST walk of the catch block, in the
 * same spirit as `normalizeBody`/`globToRegExp` elsewhere in this file: good
 * enough to catch the common shapes without a bespoke matcher for every edge
 * case. A false negative here (a deliberate swallow this misses) just means
 * the function keeps its ordinary error_handling penalty — the safe failure
 * direction, since it costs the function scrutiny rather than hiding one.
 */
export function hasDeliberateBestEffortCatch(source) {
  CATCH_RE.lastIndex = 0;
  let match;
  while ((match = CATCH_RE.exec(source))) {
    const openIndex = match.index + match[0].length - 1;
    const block = balancedBlock(source, openIndex);
    if (block === null) continue;
    if (HAS_COMMENT_RE.test(block) || HAS_NONEMPTY_RETURN_RE.test(block)) return true;
  }
  return false;
}

// ── source truncation ────────────────────────────────────────────────────

export function truncateSource(source, maxBytes) {
  const buf = Buffer.from(source, "utf8");
  if (buf.length <= maxBytes) return { text: source, truncated: false };
  // Cut on the byte cap, then back off to a clean char boundary.
  let text = buf.subarray(0, maxBytes).toString("utf8");
  text = text.replace(/�+$/, "");
  return { text: `${text}\n/* …truncated for audit (${buf.length} bytes total)… */`, truncated: true };
}

// ── AST walk ──────────────────────────────────────────────────────────────

function scriptKindFor(fileName) {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".ts")) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function lineOf(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1; // 1-based for humans
}

/** Count only the function's OWN top-level statements — a proxy for "how much is actually happening here", not full cyclomatic complexity. */
function statementCount(node) {
  const body = node.body;
  if (!body) return 0;
  if (ts.isBlock(body)) return body.statements.length;
  return 1; // concise arrow body, e.g. `(x) => x + 1`
}

function importLines(fileText) {
  return fileText
    .split(/\r?\n/)
    .filter((line) => /^\s*import\s/.test(line))
    .join("\n");
}

/** Best-effort enclosing name (class/object) so `render` inside two classes doesn't collide. */
function enclosingName(node) {
  let p = node.parent;
  while (p) {
    if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) return p.name?.text ?? "AnonymousClass";
    if (ts.isModuleDeclaration(p) && p.name && ts.isIdentifier(p.name)) return p.name.text;
    p = p.parent;
  }
  return null;
}

function nameOf(node) {
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "(anonymous function)";
  if (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
    return ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name) ? node.name.text : "(computed method)";
  }
  // Arrow/function expressions: named by whatever they were assigned to.
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return "(anonymous)";
}

function isFunctionExpressionOfInterest(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/**
 * @param {string} relPath  posix-ish path relative to repo root, used as the id prefix
 * @param {string} sourceText
 * @param {{trivialMaxStatements:number, trivialMaxLines:number, maxSourceBytes:number}} opts
 * @returns {Array<object>} extracted function records (see fields below)
 */
export function extractFromSource(relPath, sourceText, opts) {
  const sourceFile = ts.createSourceFile(relPath, sourceText, ts.ScriptTarget.Latest, true, scriptKindFor(relPath));
  const imports = importLines(sourceText);
  const records = [];
  const seenIds = new Map();

  function record(node, name, qualifier) {
    const startLine = lineOf(sourceFile, node.getStart(sourceFile));
    const endLine = lineOf(sourceFile, node.getEnd());
    const lineCount = endLine - startLine + 1;
    const stmts = statementCount(node);

    if (lineCount < opts.trivialMaxLines && stmts < opts.trivialMaxStatements) return;

    const qualifiedName = qualifier ? `${qualifier}.${name}` : name;
    let id = `${relPath}#${qualifiedName}`;
    if (seenIds.has(id)) {
      const n = seenIds.get(id) + 1;
      seenIds.set(id, n);
      id = `${id}:${startLine}`;
    } else {
      seenIds.set(id, 1);
    }

    const rawSource = sourceText.slice(node.getStart(sourceFile), node.getEnd());
    const { text: source, truncated } = truncateSource(rawSource, opts.maxSourceBytes);

    // Leading comment(s) immediately above the declaration (JSDoc or a plain
    // `//` line) — node.getStart(sourceFile) skips this trivia by default,
    // so it's pulled separately for the suppression-comment scan only; it
    // is never sent to Jev (rawSource/source above are unaffected).
    const leadingRanges = ts.getLeadingCommentRanges(sourceText, node.getFullStart()) ?? [];
    const leadingComment = leadingRanges.map((r) => sourceText.slice(r.pos, r.end)).join("\n");
    const suppressions = parseSuppressions(`${leadingComment}\n${rawSource}`);

    records.push({
      id,
      file: relPath,
      name,
      qualifiedName,
      startLine,
      endLine,
      lineCount,
      statementCount: stmts,
      source,
      truncated,
      imports,
      bodyHash: bodyHash(rawSource),
      isComponent: /^[A-Z]/.test(name) && /return\s*\(?\s*</.test(rawSource.slice(0, 4000)),
      deliberateBestEffort: hasDeliberateBestEffortCatch(rawSource),
      suppressions,
    });
  }

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.body) {
      record(node, nameOf(node), enclosingName(node));
    } else if ((ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)) && node.body) {
      record(node, nameOf(node), enclosingName(node));
    } else if (isFunctionExpressionOfInterest(node) && node.body) {
      const parent = node.parent;
      const isNamed =
        (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) ||
        (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) ||
        (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name));
      // Anonymous callbacks (`arr.map(x => ...)`) are not "functions in the
      // codebase" in the sense this audit cares about — skip unless assigned
      // to a name, which is also how "trivial noise" gets filtered for free.
      if (isNamed) record(node, nameOf(node), enclosingName(node));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return records;
}

// ── git-backed file discovery ─────────────────────────────────────────────

async function git(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

function splitLines(stdout) {
  return stdout.split(/\r?\n/).filter(Boolean);
}

function inScope(relPath, config) {
  const posix = toPosix(relPath);
  if (!config.extensions.some((ext) => posix.endsWith(ext))) return false;
  if (matchesAnyGlob(posix, config.excludeGlobs)) return false;
  return config.scopeDirs.some((dir) => posix === dir || posix.startsWith(`${toPosix(dir)}/`));
}

/**
 * All git-tracked files in scope (used by `--full`), optionally narrowed by
 * `--path` filters (each treated as a glob OR a directory prefix).
 */
export async function discoverAllFiles(config, cwd, pathFilters = []) {
  const stdout = await git(["ls-files"], cwd);
  let files = splitLines(stdout).filter((f) => inScope(f, config));
  if (pathFilters.length > 0) files = files.filter((f) => matchesPathFilters(f, pathFilters));
  return files;
}

export function matchesPathFilters(relPath, pathFilters) {
  const posix = toPosix(relPath);
  return pathFilters.some((filter) => {
    const f = toPosix(filter).replace(/\/$/, "");
    return posix === f || posix.startsWith(`${f}/`) || globToRegExp(f).test(posix);
  });
}

/**
 * Files considered "changed" for default-mode auditing: committed diff since
 * the branch point off `baseBranch`, plus anything dirty or untracked right
 * now. Deleted files are dropped (nothing left to extract functions from).
 *
 * `baseBranch` defaults to "main" for back-compat, but a multi-repo run
 * should pass the target repo's own base — `config.baseBranch`, else that
 * repo's own `maple.config.json` `repo.devBranch`, else "main" (resolved by
 * `resolveBaseBranch` in audit.mjs) — so a repo whose integration branch
 * isn't literally named `main` (e.g. EasyCaller's `development`) gets a real
 * diff instead of silently falling back to working-tree-only.
 */
export async function discoverChangedFiles(config, cwd, pathFilters = [], baseBranch = "main") {
  let base;
  try {
    base = (await git(["merge-base", "HEAD", baseBranch], cwd)).trim();
  } catch {
    base = null; // no such base branch (e.g. detached, or a repo without that branch name) — fall back to working-tree-only
  }

  const sets = await Promise.all([
    base ? git(["diff", "--name-only", "--diff-filter=d", base, "HEAD"], cwd) : Promise.resolve(""),
    git(["diff", "--name-only", "--diff-filter=d", "HEAD"], cwd),
    git(["ls-files", "--others", "--exclude-standard"], cwd),
  ]);

  const files = new Set();
  for (const stdout of sets) for (const f of splitLines(stdout)) files.add(f);

  let scoped = [...files].filter((f) => inScope(f, config));
  if (pathFilters.length > 0) scoped = scoped.filter((f) => matchesPathFilters(f, pathFilters));
  return scoped;
}

/** Every `*.test.*` file in the repo, for the deterministic `has_test_reference` check — this is a fact-lookup, never sent to Jev (see hasTestReference in audit-questions.mjs). */
export async function discoverTestFiles(cwd) {
  const stdout = await git(["ls-files"], cwd);
  return splitLines(stdout).filter((f) => /\.test\.(ts|tsx|mjs|js)$/.test(f));
}

/**
 * Buckets a path to its top-level scope directory for the report's module
 * heatmap. `config.moduleLabels` (keyed by the exact `scopeDirs` entry) lets
 * a config override the default "first path segment" label — needed for
 * EasyCaller, where `services/call-plane/src` and `services/srs/src` would
 * otherwise both collapse to the single label `services`, losing the split
 * the heatmap is for. Absent `moduleLabels`, behaviour is unchanged.
 */
export function moduleOf(relPath, config) {
  const posix = toPosix(relPath);
  for (const dir of config.scopeDirs) {
    const d = toPosix(dir);
    if (posix === d || posix.startsWith(`${d}/`)) {
      return config.moduleLabels?.[dir] ?? d.split("/")[0];
    }
  }
  return "other";
}
