/**
 * exposure.mjs - the `stack-exposure` preset (D072, docs/stack-exposure.md): what a build serves to an
 * anonymous visitor must not name the stack.
 *
 * Origin: EasyCaller's stack exposure audit (2026-10-08). Its login page preloaded 82 app chunks; a crawl from
 * /login fetched 220 files / 5.9 MB including exact library versions, the whole `import.meta.env` (commit SHA,
 * internal hostnames, dev-flag names), Tailwind's `/*!` banner, readable chunk names and a dev-only route.
 * Each rule below is one of those findings, so a regression fails the gate instead of waiting for an audit.
 *
 * For every configured surface `{ name, dir, build, exclude?, hashOnly?, loginEntry?, loginBudget? }`:
 * run `build` in the project root (the gate certifies a clean HEAD, so this is the candidate commit), then walk
 * the SERVED files under `dir` (minus `exclude` prefixes, e.g. a `_worker.js` bundle the host never serves).
 *
 * Rules (finding ids). One finding per rule + surface + key, located at the surface dir with the key as
 * `resource`, so it stays stable across builds whose file names are content hashes and a decision-backed
 * exception (predeploy-decisions.json, `scope: "<dir>#<resource>"`) can name exactly one unavoidable item:
 *   source-map            *.map served, or a sourceMappingURL comment
 *   sensitive-file        .env*, package.json, lockfiles, .git/, .vite/ manifest, tsbuildinfo, stats.html
 *   license-banner        `/*!`, `@license`, `@preserve` comments (move notices to a licenses file)
 *   env-dump              an inlined env object (`VITE_X:` keys, Vite's `BASE_URL:..,MODE:` object)
 *   commit-sha            the candidate commit SHA (full or its first `shaPrefix` chars, default 12)
 *   package-version       a lockfile package's exact version next to its name (`react-dom` ... "19.3.0")
 *   readable-asset-name   a file under `hashOnly.dir` (default `assets`) whose name is not hash-only
 *   dev-route             an `options.devRoutes` string (dev/test-only route) is in the build
 *   forbidden-string      an `options.forbidden` string (internal hostname, team name...) is in the build
 *   login-graph-files / login-graph-bytes / login-graph-marker
 *                         what the static `loginEntry` HTML reaches exceeds `loginBudget` or names an app marker
 *   build-failed / surface-missing   the build did not produce the surface (never a silent pass)
 * Source rules over the tracked tree (no build needed):
 *   nginx-server-tokens   an nginx server block in a file without `server_tokens off;`
 *   express-powered-by    a package depending on express with no x-powered-by disable in its sources
 */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runShell } from "./lib.mjs";

export const DEFAULT_ENV_PREFIXES = ["VITE_", "NEXT_PUBLIC_", "REACT_APP_", "NUXT_PUBLIC_", "EXPO_PUBLIC_", "GATSBY_"];
export const DEFAULT_HASH_PATTERN = "^[A-Za-z0-9_-]{8}(\\.[a-z0-9]+)+$";
export const DEFAULT_LOGIN_BUDGET = { maxFiles: 30, maxBytes: 400000 };
const TEXT_FILE = /\.(m?js|cjs|css|html?|json|txt|svg|xml|webmanifest)$/i;
const CODE_FILE = /\.(m?js|cjs|css|html?)$/i;
const SENSITIVE = /(^|\/)(\.env[^/]*|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.git(\/.*)?|\.vite\/.*|[^/]*\.tsbuildinfo|stats\.html|\.DS_Store)$/;
const BANNER = /\/\*!|\/[/*][^\n]{0,6}@(?:license|preserve)\b/;
const SOURCE_MAP_COMMENT = /[#@]\s*sourceMappingURL\s*=/;
const VITE_ENV_OBJECT = /\bBASE_URL["'`]?\s*:\s*["'`][^"'`]*["'`]\s*,\s*["'`]?(?:MODE|DEV|PROD|SSR)["'`]?\s*:/;
const VERSION = /(?<=["'`v/@ ])\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?![\d.])/g;
const REF = /(?:["'`(]|^)((?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)*[\w@.-]+\.(?:m?js|css|woff2?|ttf|png|jpe?g|svg|webp|wasm|json))(?:\?[^"'`)\s]*)?(?=["'`)])/gm;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const F = (id, message, location, resource, severity = "medium") => ({ id, severity, message, location, resource });

/** Every served file under dir (POSIX rel paths), skipping `exclude` prefixes. Links are not followed. */
export function walkServed(dir, exclude = []) {
  const out = [];
  const visit = (abs, rel) => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (exclude.some((p) => r === p || r.startsWith(p.replace(/\/?$/, "/")))) continue;
      const full = join(abs, ent.name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) visit(full, r);
      else out.push({ rel: r, full, bytes: st.size });
    }
  };
  visit(dir, "");
  return out;
}

export function envDumpPattern(extra = []) {
  const prefixes = [...new Set([...DEFAULT_ENV_PREFIXES, ...extra])].map(esc).join("|");
  return new RegExp(`(?:^|[^A-Za-z0-9_$])["'\`]?((?:${prefixes})[A-Z0-9_]+)["'\`]?\\s*:`);
}

/** version -> [package names] from every lockfile text given ({ kind: "npm"|"pnpm", text }). */
export function versionIndex(locks) {
  const idx = new Map();
  const add = (name, version) => {
    // @types/* never reach a bundle, but share versions with their runtime package (@types/react-dom 19.3.0).
    if (!name || name.startsWith("@types/") || !/^\d+\.\d+\.\d+/.test(version || "")) return;
    const list = idx.get(version) || [];
    if (!list.includes(name)) list.push(name);
    idx.set(version, list);
  };
  for (const { kind, text } of locks) {
    if (kind === "npm") {
      let j;
      try { j = JSON.parse(text); } catch { continue; }
      for (const [p, e] of Object.entries(j.packages || {})) if (p) add(e.name || p.replace(/^.*node_modules\//, ""), e.version);
    } else {
      for (const m of text.matchAll(/^\s{2}['"]?\/?((?:@[^/\s'"]+\/)?[^@\s'"/]+)@(\d+\.\d+\.\d+[^:'"(\s]*)/gm)) add(m[1], m[2]);
    }
  }
  return idx;
}

const nameRe = new Map();
function namedNear(name, window) {
  if (!nameRe.has(name)) nameRe.set(name, new RegExp(`(?:^|[^A-Za-z0-9_-])${esc(name)}(?:[^A-Za-z0-9_-]|$)`, "i"));
  return nameRe.get(name).test(window);
}

/** Package names whose exact version appears in `text` within 100 chars of the name (or its unscoped basename, >= 3 chars). */
export function packageVersions(text, index) {
  const hits = new Map();
  for (const m of text.matchAll(VERSION)) {
    const names = index.get(m[0]);
    if (!names) continue;
    const window = text.slice(Math.max(0, m.index - 100), m.index + m[0].length + 100);
    for (const name of names) {
      const base = name.replace(/^@[^/]+\//, "");
      // Unscoped names under 3 chars ("ms", "ws") are everywhere in minified code; a scoped full name is always specific.
      if ((base !== name && namedNear(name, window)) || (base.length >= 3 && namedNear(base, window))) hits.set(name, m[0]);
    }
  }
  return hits;
}

/** Text rules for one served file: [{ rule, key, detail }]. Shared with the live login crawl. */
export function textRules(text, { envRe, shas = [], devRoutes = [], forbidden = [], index = null } = {}) {
  const out = [];
  const banner = BANNER.exec(text);
  if (banner) out.push({ rule: "license-banner", key: "banner", detail: text.slice(banner.index, banner.index + 60).replace(/\s+/g, " ") });
  if (SOURCE_MAP_COMMENT.test(text)) out.push({ rule: "source-map", key: "sourceMappingURL", detail: "sourceMappingURL comment" });
  const env = (envRe || envDumpPattern()).exec(text);
  if (env) out.push({ rule: "env-dump", key: env[1], detail: `inlined env key ${env[1]}` });
  if (VITE_ENV_OBJECT.test(text)) out.push({ rule: "env-dump", key: "import.meta.env", detail: "Vite's whole env object ({BASE_URL, MODE, ...})" });
  for (const s of shas) if (s && text.includes(s)) { out.push({ rule: "commit-sha", key: "sha", detail: `commit SHA ${s.slice(0, 12)}...` }); break; }
  for (const r of devRoutes) if (text.includes(r)) out.push({ rule: "dev-route", key: r, detail: `dev-only route ${r}` });
  for (const s of forbidden) if (text.includes(s)) out.push({ rule: "forbidden-string", key: s, detail: `forbidden string ${s}` });
  if (index) for (const [name, v] of packageVersions(text, index)) out.push({ rule: "package-version", key: name, detail: `${name} ${v}` });
  return out;
}

/** Fold per-file hits into one finding per rule+key: location = surface dir, resource = key, up to 5 example files. */
export function foldHits(surfaceDir, hits) {
  const by = new Map();
  for (const h of hits) {
    const k = `${h.rule}\u0000${h.key}`;
    const cur = by.get(k) || { ...h, files: [] };
    if (cur.files.length < 5 && !cur.files.includes(h.file)) cur.files.push(h.file);
    cur.count = (cur.count || 0) + 1;
    by.set(k, cur);
  }
  const SEV = { "source-map": "high", "sensitive-file": "high", "license-banner": "low", "readable-asset-name": "low" };
  return [...by.values()].map((h) => F(h.rule, `${h.detail} (${h.count} file${h.count === 1 ? "" : "s"}: ${h.files.join(", ")})`.slice(0, 300), surfaceDir, h.key, SEV[h.rule] || "medium"));
}

/** Static reference graph from a login HTML file inside the served dir. */
export function loginGraph(files, entry) {
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const seen = new Set();
  const queue = [entry];
  while (queue.length && seen.size < 2000) {
    const rel = queue.shift();
    if (seen.has(rel) || !byRel.has(rel)) continue;
    seen.add(rel);
    const f = byRel.get(rel);
    if (!CODE_FILE.test(rel)) continue;
    const text = readFileSync(f.full, "utf8");
    const baseDir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    for (const m of text.matchAll(REF)) {
      const spec = m[1];
      const target = spec.startsWith("/") ? spec.slice(1) : normalizeRel(baseDir ? `${baseDir}/${spec}` : spec);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  const reached = [...seen].map((r) => byRel.get(r));
  return { reached, bytes: reached.reduce((n, f) => n + f.bytes, 0) };
}

function normalizeRel(p) {
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop(); else parts.push(seg);
  }
  return parts.join("/");
}

function loginFindings(s, files, markers) {
  if (!s.loginEntry) return [];
  const where = `${s.dir}/${s.loginEntry}`;
  if (!files.some((f) => f.rel === s.loginEntry)) return [F("login-graph-missing", `loginEntry ${s.loginEntry} is not in the built surface`, where, undefined, "high")];
  const budget = { ...DEFAULT_LOGIN_BUDGET, ...(s.loginBudget || {}) };
  const g = loginGraph(files, s.loginEntry);
  const out = [];
  if (g.reached.length > budget.maxFiles) out.push(F("login-graph-files", `the login page reaches ${g.reached.length} files (budget ${budget.maxFiles})`, where));
  if (g.bytes > budget.maxBytes) out.push(F("login-graph-bytes", `the login page reaches ${g.bytes} bytes (budget ${budget.maxBytes})`, where));
  for (const f of g.reached) {
    if (!TEXT_FILE.test(f.rel)) continue;
    const text = readFileSync(f.full, "utf8");
    for (const mk of markers) if (text.includes(mk)) out.push(F("login-graph-marker", `app-only marker "${mk}" is reachable from the login page (${f.rel})`, where, mk));
  }
  return out;
}

/** Pure-ish scan of one built surface (filesystem reads only). */
export function scanSurface(s, { root, shas, envRe, index, devRoutes, forbidden, markers }) {
  const abs = join(root, s.dir);
  if (!existsSync(abs)) return [F("surface-missing", `surface ${s.name}: ${s.dir} does not exist after the build`, s.dir, undefined, "high")];
  const files = walkServed(abs, s.exclude || []);
  const hits = [];
  const hash = s.hashOnly === undefined ? { dir: "assets" } : s.hashOnly;
  const hashRe = new RegExp(hash.pattern || DEFAULT_HASH_PATTERN);
  for (const f of files) {
    if (/\.map$/i.test(f.rel)) hits.push({ rule: "source-map", key: "map-file", detail: "source map file served", file: f.rel });
    else if (SENSITIVE.test(f.rel)) hits.push({ rule: "sensitive-file", key: f.rel, detail: `${f.rel} is served`, file: f.rel });
    if (f.rel.startsWith(`${hash.dir}/`) && !hashRe.test(f.rel.split("/").pop())) hits.push({ rule: "readable-asset-name", key: hash.dir, detail: "asset names are not hash-only", file: f.rel });
    if (!TEXT_FILE.test(f.rel) || f.bytes > 50 * 1024 * 1024) continue;
    const text = readFileSync(f.full, "utf8");
    for (const h of textRules(text, { envRe, shas, devRoutes, forbidden, index })) hits.push({ ...h, file: f.rel });
  }
  return [...foldHits(s.dir, hits), ...loginFindings(s, files, markers)];
}

// ── source rules over the tracked tree ──────────────────────────────────────
const NGINX_SERVER = /^\s*server\s*\{/m;
const NGINX_DIRECTIVE = /^\s*(listen|server_name|proxy_pass|location|root)\b/m;
const NGINX_CANDIDATE = /(^|\/)(nginx[^/]*\/.*|[^/]*\.(conf|tftpl|tpl|template|j2|sh|ya?ml))$/;

export function nginxFindings(files) {
  return files.filter((f) => NGINX_SERVER.test(f.text) && NGINX_DIRECTIVE.test(f.text) && !/\bserver_tokens\s+off\s*;/.test(f.text))
    .map((f) => F("nginx-server-tokens", "nginx server block without `server_tokens off;` (error pages and the Server header name the nginx version)", f.path, undefined, "medium"));
}

export function expressFindings(pkgs, sourcesOf) {
  const out = [];
  for (const { path, json } of pkgs) {
    const deps = { ...(json.dependencies || {}), ...(json.optionalDependencies || {}) };
    if (!deps.express) continue;
    const dir = path.replace(/\/?package\.json$/, "");
    if (!sourcesOf(dir).some((t) => /x-powered-by/i.test(t) || /\bhelmet\b/.test(t))) out.push(F("express-powered-by", "express sends `X-Powered-By: Express` by default; call app.disable(\"x-powered-by\") (or use helmet)", path, "express"));
  }
  return out;
}

function sourceRules(ctx) {
  const read = (p) => { try { return readFileSync(join(ctx.scanRoot, p), "utf8"); } catch { return ""; } };
  const nginx = nginxFindings(ctx.listFiles(NGINX_CANDIDATE).filter((p) => !/(^|\/)(node_modules|dist|docs)\//.test(p)).map((p) => ({ path: p, text: read(p) })));
  const pkgs = ctx.listFiles(/(^|\/)package\.json$/).filter((p) => !/node_modules\//.test(p)).flatMap((p) => { try { return [{ path: p, json: JSON.parse(read(p)) }]; } catch { return []; } });
  const sourcesOf = (dir) => ctx.listFiles(/\.(m?[jt]sx?|cjs)$/).filter((p) => (dir ? p.startsWith(dir + "/") : true) && !/node_modules\//.test(p)).map(read);
  return [...nginx, ...expressFindings(pkgs, sourcesOf)];
}

function lockTexts(ctx) {
  const locks = [];
  for (const p of ctx.listFiles(/(^|\/)package-lock\.json$/)) locks.push({ kind: "npm", text: readFileSync(join(ctx.scanRoot, p), "utf8") });
  for (const p of ctx.listFiles(/(^|\/)pnpm-lock\.yaml$/)) locks.push({ kind: "pnpm", text: readFileSync(join(ctx.scanRoot, p), "utf8") });
  return locks;
}

/** The preset entry point (INTERNAL_PRESETS["stack-exposure"].run). */
export async function stackExposure(o, ctx) {
  const findings = sourceRules(ctx);
  const notes = [];
  const prefix = Number.isInteger(o.shaPrefix) ? o.shaPrefix : 12;
  const shas = [ctx.sha, ctx.sha.slice(0, prefix)];
  const opts = { root: ctx.root, shas, envRe: envDumpPattern(o.envPrefixes || []), index: versionIndex(lockTexts(ctx)), devRoutes: o.devRoutes || [], forbidden: o.forbidden || [], markers: o.appMarkers || [] };
  for (const s of o.surfaces || []) {
    const b = runShell(s.build, { cwd: ctx.root, env: { PREDEPLOY_SHA: ctx.sha }, timeoutSec: s.buildTimeoutSec || 1800 });
    if (b.status !== 0) {
      findings.push(F("build-failed", `surface ${s.name}: \`${s.build}\` exited ${b.timedOut ? "on timeout" : b.status}: ${(b.stderr || b.stdout).trim().split(/\r?\n/).slice(-2).join(" | ").slice(0, 200)}`, s.dir, undefined, "high"));
      continue;
    }
    const got = scanSurface(s, opts);
    findings.push(...got);
    notes.push(`surface ${s.name} (${s.dir}): ${got.length} finding(s)`);
  }
  return { findings, notes };
}
