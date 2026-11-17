/**
 * heavy-carry-rules.mjs - the PURE rules of heavy stamp carry-over (opt-in `gate.heavyCarryOver`, amends D060/D066).
 * No git, no fs: config validation, the exact-path allow-list, the structural maple.config.json diff and its key matcher.
 * The git-backed eligibility proof lives in heavy-carry.mjs.
 *
 * Config (maple.config.json):
 *   "gate": { "heavyCarryOver": { "enabled": false, "paths": ["predeploy-allowlist.json", "maple.config.json"],
 *                                  "configKeys": ["predeploy.checks[*].timeoutSec"] } }
 *
 * paths       EXACT repo-relative file names. Built-in refusals config cannot lift: the file must be a TOP-LEVEL `.json`
 *             file (no directory, no glob, no `..`, no absolute path, no backslash) and must not be a well-known tool
 *             manifest/config that build or test tooling loads by itself (package.json, tsconfig*.json, ...).
 * configKeys  Key paths inside maple.config.json whose value may change. Grammar: dot-separated keys, with an array
 *             element selector after a key: `[*]` (any element), `[id=<id>]` (the element whose `id` is <id>) or `[<n>]`.
 *             The match is EXACT over the whole path (no prefix match). Only keys under `predeploy.` may be listed (the
 *             predeploy gate still runs on the carried commit and re-certifies its own configuration), and never
 *             `predeploy.enabled|fastLane|deployGuard|emergency|allowlist|decisions|imageDebt.file` or a leaf named
 *             `command|preset|github|parse|regex|workflow|enabled`.
 *             Required (non-empty) when `maple.config.json` is in `paths`.
 *
 * A config change is allowed only as a SCALAR leaf change (string/number/boolean/null, or a key added/removed with a
 * scalar value) whose parent object exists on both sides, at a path some configKeys pattern matches. Arrays whose
 * elements all carry a unique string `id` are compared by id (the id sequence itself must be identical: adding, removing
 * or reordering elements is structural); other arrays by index. Any change in length or id sequence is a structural
 * change and always refuses.
 */

export const CARRY_KEY = "gate.heavyCarryOver";
export const CONFIG_FILE = "maple.config.json";
/** First-parent commits a carry may reach back. A late-round data fix is a handful of commits, not a release. */
export const MAX_DISTANCE = 100;

/** Top-level `.json` files that tooling loads on its own: never carry-able, whatever the config says. */
export const DENIED_FILES = [
  /^package(-lock)?\.json$/i, /^npm-shrinkwrap\.json$/i, /^composer\.(json|lock)$/i, /^bower\.json$/i,
  /^[jt]sconfig([.-][^/]*)?\.json$/i, /^deno\.jsonc?$/i, /^import_map\.json$/i, /^vercel\.json$/i, /^wrangler\.jsonc?$/i,
  /^netlify\.json$/i, /^firebase\.json$/i, /^app\.json$/i, /^now\.json$/i, /^knip\.jsonc?$/i, /^renovate\.json5?$/i,
  /^turbo\.json$/i, /^nx\.json$/i, /^lerna\.json$/i, /^project\.json$/i, /^angular\.json$/i, /^biome\.jsonc?$/i,
  /^\.eslintrc(\.json)?$/i, /^\.prettierrc(\.json)?$/i, /^\.babelrc(\.json)?$/i, /^babel\.config\.json$/i,
  /^\.swcrc$/i, /^components\.json$/i, /^\.mocharc\.json$/i, /^jest\.config\.json$/i, /^\.c8rc\.json$/i, /^\.nycrc(\.json)?$/i,
  /^\.release-please[^/]*\.json$/i, /^release-please[^/]*\.json$/i, /^cspell\.json$/i,
];

const DENIED_KEY_PREFIXES = [
  ["predeploy", "enabled"], ["predeploy", "fastLane"], ["predeploy", "deployGuard"], ["predeploy", "emergency"],
  ["predeploy", "allowlist"], ["predeploy", "decisions"], ["predeploy", "imageDebt", "file"],
];
const DENIED_LEAVES = new Set(["command", "preset", "github", "parse", "regex", "workflow", "enabled"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isScalar = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);

// ── paths ───────────────────────────────────────────────────────────────────
/** null when `p` may be listed in `paths`, else why not. */
export function pathProblem(p) {
  if (typeof p !== "string" || !p.length) return "must be a non-empty string";
  if (p !== p.trim()) return "must not have leading/trailing whitespace";
  if (/[\\]/.test(p)) return "must use no backslash (an exact repo-relative path)";
  if (/^[A-Za-z]:|^\//.test(p)) return "must be repo-relative, not absolute";
  if (/[*?[\]{}!]/.test(p)) return "must be an exact file path (no glob characters)";
  if (p.split("/").some((s) => s === ".." || s === ".")) return "must not contain `.` or `..` segments";
  if (p.includes("/")) return "must be a top-level file (carry-over never covers a file inside a directory: directories hold code, tests, migrations, scripts and workflows)";
  if (!/\.json$/.test(p)) return "must be a `.json` data file";
  if (DENIED_FILES.some((re) => re.test(p))) return "is a tool manifest/config that build or test tooling loads by itself";
  return null;
}

// ── key patterns ────────────────────────────────────────────────────────────
const KEY = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
const ID = /^[A-Za-z0-9_.:-]+$/;

/** `a.b[*].c` -> [{k:"a"},{k:"b"},{any:true},{k:"c"}]. Throws on bad grammar. */
export function parseKeyPattern(pattern) {
  if (typeof pattern !== "string" || !pattern.length) throw new Error("must be a non-empty string");
  const toks = [];
  let i = 0;
  const s = pattern;
  while (i < s.length) {
    if (s[i] === "[") {
      if (!toks.length) throw new Error("cannot start with a selector");
      const end = s.indexOf("]", i);
      if (end < 0) throw new Error("unclosed `[`");
      const body = s.slice(i + 1, end);
      if (body === "*") toks.push({ any: true });
      else if (/^\d+$/.test(body)) toks.push({ i: Number(body) });
      else if (body.startsWith("id=") && ID.test(body.slice(3))) toks.push({ id: body.slice(3) });
      else throw new Error(`bad selector "[${body}]" (use [*], [id=<id>] or [<n>])`);
      i = end + 1;
      if (i < s.length && s[i] !== "." && s[i] !== "[") throw new Error("a selector must be followed by `.`, `[` or the end");
      if (s[i] === ".") i++;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== "." && s[j] !== "[") j++;
    const key = s.slice(i, j);
    if (!KEY.test(key)) throw new Error(`bad key "${key}"`);
    toks.push({ k: key });
    i = j;
    if (s[i] === ".") { i++; if (i >= s.length) throw new Error("ends with `.`"); }
  }
  if (!toks.length || !("k" in toks[toks.length - 1])) throw new Error("must end in a key name");
  return toks;
}

/** Built-in refusal for a parsed path (pattern or concrete change): null when allowed, else why not. */
export function keyProblem(toks) {
  if (toks[0]?.k !== "predeploy") return "only keys under `predeploy.` may be carried (the predeploy gate re-certifies them on the carried commit; anything else can change what heavy runs or how the guards enforce)";
  const keys = toks.map((t) => t.k);
  for (const pre of DENIED_KEY_PREFIXES) if (pre.every((k, n) => keys[n] === k)) return `\`${pre.join(".")}\` is never carry-able`;
  const leaf = toks[toks.length - 1];
  if (leaf && "k" in leaf && DENIED_LEAVES.has(leaf.k)) return `a \`${leaf.k}\` key changes what runs or whether it runs, never carry-able`;
  return null;
}

export const formatPath = (toks) => toks.map((t, n) => ("k" in t ? (n ? "." : "") + t.k : "any" in t ? "[*]" : "id" in t ? `[id=${t.id}]` : `[${t.i}]`)).join("");

/** Does a parsed pattern match a concrete change path (tokens with k / id / i)? Exact length, `[*]` = any element. */
export function matchKey(pattern, path) {
  if (pattern.length !== path.length) return false;
  return pattern.every((p, n) => {
    const c = path[n];
    if ("k" in p) return c.k === p.k;
    if ("k" in c) return false;
    if (p.any) return true;
    if ("id" in p) return c.id === p.id;
    return c.i === p.i;
  });
}

// ── structural JSON diff ────────────────────────────────────────────────────
function idsOf(arr) {
  if (!arr.every((e) => isObj(e) && typeof e.id === "string" && e.id.length)) return null;
  const ids = arr.map((e) => e.id);
  return new Set(ids).size === ids.length ? ids : null;
}

/**
 * Every difference between two JSON values, as {path: tokens, before, after, structural?}. `structural` marks a change
 * that is never a scalar leaf edit (array length / id sequence, a new or removed object, a type flip).
 */
export function jsonChanges(a, b, path = []) {
  if (isObj(a) && isObj(b)) {
    const out = [];
    for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const p = [...path, { k }];
      if (!(k in a)) out.push({ path: p, before: undefined, after: b[k], structural: !isScalar(b[k]) });
      else if (!(k in b)) out.push({ path: p, before: a[k], after: undefined, structural: !isScalar(a[k]) });
      else out.push(...jsonChanges(a[k], b[k], p));
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const ia = idsOf(a), ib = idsOf(b);
    if (ia && ib) {
      if (ia.join("\0") !== ib.join("\0")) return [{ path, before: a, after: b, structural: true }];
      return a.flatMap((e, n) => jsonChanges(e, b[n], [...path, { id: e.id }]));
    }
    if (a.length !== b.length) return [{ path, before: a, after: b, structural: true }];
    return a.flatMap((e, n) => jsonChanges(e, b[n], [...path, { i: n }]));
  }
  if (isScalar(a) && isScalar(b)) return Object.is(a, b) ? [] : [{ path, before: a, after: b }];
  return [{ path, before: a, after: b, structural: true }];
}

/**
 * Judge the maple.config.json changes between the origin and HEAD.
 * @returns {{ok:boolean, changed:string[], refused:{key:string, reason:string}[]}}
 */
export function judgeConfigChange(before, after, configKeys) {
  const patterns = (configKeys || []).map((p) => parseKeyPattern(p));
  const changed = [];
  const refused = [];
  for (const c of jsonChanges(before, after)) {
    const key = formatPath(c.path) || "(root)";
    if (c.path[0]?.k === "gate" || c.path.length === 0) { refused.push({ key, reason: "the `gate` block (heavy carry-over's own config) never changes in a carry" }); continue; }
    if (c.path[0]?.k === "ci") { refused.push({ key, reason: "`ci.*` decides what the heavy tier runs" }); continue; }
    const kp = keyProblem(c.path);
    if (kp) { refused.push({ key, reason: kp }); continue; }
    if (c.structural) { refused.push({ key, reason: "structural change (array length / id order, object added or removed, type change): only scalar leaf edits carry" }); continue; }
    if (!patterns.some((p) => matchKey(p, c.path))) { refused.push({ key, reason: "matches no gate.heavyCarryOver.configKeys pattern" }); continue; }
    changed.push(key);
  }
  return { ok: refused.length === 0, changed, refused };
}

// ── raw diff entries ────────────────────────────────────────────────────────
/**
 * Judge `git diff --raw` entries {status, oldMode, newMode, path}. Only in-place content edits of listed regular files.
 * @returns {{ok:boolean, paths:string[], refused:{path:string, reason:string}[]}}
 */
export function judgeEntries(entries, paths) {
  const listed = new Set(paths || []);
  const ok = [];
  const refused = [];
  for (const e of entries) {
    const why =
      e.oldMode === "160000" || e.newMode === "160000" ? "submodule change"
      : e.oldMode === "120000" || e.newMode === "120000" ? "symbolic link"
      : e.status === "A" ? "file added"
      : e.status === "D" ? "file deleted"
      : e.status !== "M" ? `change type ${e.status} (rename/copy/type change)`
      : e.oldMode !== e.newMode ? `mode change ${e.oldMode} -> ${e.newMode}`
      : e.newMode !== "100644" ? `not a regular non-executable file (mode ${e.newMode})`
      : !listed.has(e.path) ? "not in gate.heavyCarryOver.paths"
      : pathProblem(e.path);
    if (why) refused.push({ path: e.path, reason: why });
    else ok.push(e.path);
  }
  return { ok: refused.length === 0, paths: ok, refused };
}

// ── config ──────────────────────────────────────────────────────────────────
/** The carry settings in a parsed maple.config.json, or null when not switched on. */
export function normalizeHeavyCarry(cfg) {
  const h = cfg?.gate?.heavyCarryOver;
  if (!isObj(h) || h.enabled !== true) return null;
  return { enabled: true, paths: Array.isArray(h.paths) ? h.paths : [], configKeys: Array.isArray(h.configKeys) ? h.configKeys : [] };
}

/** Validation errors for the whole `gate` block (validate-config.mjs). */
export function validateGate(gate) {
  if (gate === undefined) return [];
  if (!isObj(gate)) return ["gate: must be an object"];
  const e = [];
  for (const k of Object.keys(gate)) if (k !== "heavyCarryOver") e.push(`gate.${k}: unknown key`);
  const h = gate.heavyCarryOver;
  if (h === undefined) return e;
  if (!isObj(h)) return [...e, "gate.heavyCarryOver: must be an object { enabled, paths, configKeys? }"];
  for (const k of Object.keys(h)) if (!["enabled", "paths", "configKeys"].includes(k)) e.push(`gate.heavyCarryOver.${k}: unknown key`);
  if (typeof h.enabled !== "boolean") e.push("gate.heavyCarryOver.enabled: required boolean (off unless a project switches it on)");
  if (h.paths !== undefined) {
    if (!Array.isArray(h.paths)) e.push("gate.heavyCarryOver.paths: must be an array of exact top-level .json file names");
    else {
      h.paths.forEach((p, n) => { const why = pathProblem(p); if (why) e.push(`gate.heavyCarryOver.paths[${n}]: "${p}" ${why}`); });
      if (new Set(h.paths).size !== h.paths.length) e.push("gate.heavyCarryOver.paths: duplicate entries");
    }
  }
  if (h.configKeys !== undefined) {
    if (!Array.isArray(h.configKeys)) e.push("gate.heavyCarryOver.configKeys: must be an array of key-path patterns");
    else h.configKeys.forEach((p, n) => {
      let toks;
      try { toks = parseKeyPattern(p); } catch (x) { e.push(`gate.heavyCarryOver.configKeys[${n}]: "${p}" ${x.message}`); return; }
      const why = keyProblem(toks);
      if (why) e.push(`gate.heavyCarryOver.configKeys[${n}]: "${p}" ${why}`);
    });
  }
  const paths = Array.isArray(h.paths) ? h.paths : [];
  if (h.enabled === true && paths.length === 0) e.push("gate.heavyCarryOver.paths: required non-empty array when enabled");
  if (paths.includes(CONFIG_FILE) && !(Array.isArray(h.configKeys) && h.configKeys.length)) e.push("gate.heavyCarryOver.configKeys: required non-empty when maple.config.json is in paths");
  if (Array.isArray(h.configKeys) && h.configKeys.length && !paths.includes(CONFIG_FILE)) e.push("gate.heavyCarryOver.configKeys: listed but maple.config.json is not in paths");
  return e;
}
