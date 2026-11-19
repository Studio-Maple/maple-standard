/**
 * manifests.mjs - the direct dependencies a project already declares, across every package.json, pyproject.toml and
 * requirements*.txt under its root (node_modules, .git, .worktrees, .claude and build output skipped). Used to tell a
 * NEW package from an existing one (reputation checks, D080) and a new DIRECT dependency (necessity, D086).
 * Filesystem only, bounded (depth, file count), never throws.
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { depRows } from "./pkgjson.mjs";

const SKIP_DIRS = new Set(["node_modules", ".git", ".worktrees", ".claude", ".next", ".turbo", "dist", "build", "coverage", ".venv", "venv", "env", "__pycache__", ".tox", ".mypy_cache", "site-packages", ".cache", "out", "target"]);
const MAX_DEPTH = 6;
const MAX_DIRS = 3000;

// workspace-internal packages are not external dependencies (no reputation or necessity check applies)
const INTERNAL_SPEC = /^(workspace:|file:|link:|portal:)/i;

/** True for a repo-relative manifest path under a skipped directory (same rule scanManifests applies while walking). */
export const inSkippedDir = (file) => file.split("/").slice(0, -1).some((d) => SKIP_DIRS.has(d) || d.startsWith("."));

export const isManifestName = (f) => f === "package.json" || f === "pyproject.toml" || /^requirements[\w.-]*\.txt$/i.test(f);
const normPy = (n) => n.toLowerCase().replace(/[-_.]+/g, "-");

function quoted(line) {
  return [...line.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}
function pyName(spec) {
  const m = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(spec);
  return m ? normPy(m[1]) : null;
}

/** Parse a pyproject.toml line by line (no TOML dependency): PEP 621, dependency-groups, uv dev-dependencies, poetry. */
export function parsePyproject(text) {
  const runtime = new Set();
  const dev = new Set();
  let section = "";
  let arrayInto = null; // Set the currently open multi-line array feeds
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, "").trim();
    if (arrayInto) {
      for (const q of quoted(line)) { const n = pyName(q); if (n) arrayInto.add(n); }
      if (line.includes("]")) arrayInto = null;
      continue;
    }
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) { section = head[1].trim(); continue; }
    const target = (key) => {
      if (section === "project" && key === "dependencies") return runtime;
      if (section === "project.optional-dependencies") return runtime; // extras ship to users
      if (section === "dependency-groups") return /^dev|test|lint|docs|typing/i.test(key) ? dev : runtime;
      if (section === "tool.uv" && key === "dev-dependencies") return dev;
      return null;
    };
    const kv = /^([\w.-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const set = target(kv[1]);
    if (set) {
      for (const q of quoted(kv[2])) { const n = pyName(q); if (n) set.add(n); }
      if (kv[2].startsWith("[") && !kv[2].includes("]")) arrayInto = set;
    } else if (/^tool\.poetry\.dependencies$/.test(section) || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)) {
      if (kv[1].toLowerCase() === "python") continue;
      const isDev = section !== "tool.poetry.dependencies" && /\.group\.(dev|test|lint|docs)/i.test(section);
      (isDev ? dev : runtime).add(normPy(kv[1]));
    } else if (section === "tool.poetry.dev-dependencies" && kv[1].toLowerCase() !== "python") dev.add(normPy(kv[1]));
  }
  return { runtime, dev };
}

export function parseRequirements(text) {
  const runtime = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*$/, "").trim();
    if (!line || line.startsWith("-") || /^(git\+|https?:|\.|\/)/.test(line)) continue;
    const n = pyName(line);
    if (n) runtime.add(n);
  }
  return { runtime, dev: new Set() };
}

/** Names declared by one manifest file's text: { eco, runtime:Set, dev:Set } or null. */
export function parseManifest(file, text) {
  const base = basename(file);
  try {
    if (base === "package.json") {
      const runtime = new Set();
      const dev = new Set();
      for (const [section, name, spec] of depRows(JSON.parse(text))) if (!INTERNAL_SPEC.test(spec.trim())) (section === "devDependencies" ? dev : runtime).add(name.toLowerCase());
      return { eco: "npm", runtime, dev };
    }
    if (base === "pyproject.toml") return { eco: "PyPI", ...parsePyproject(text) };
    if (/^requirements/i.test(base)) {
      const r = parseRequirements(text);
      // requirements-dev.txt / requirements/dev.txt style files are dev-only
      return { eco: "PyPI", runtime: /dev|test|lint/i.test(file) ? new Set() : r.runtime, dev: /dev|test|lint/i.test(file) ? r.runtime : new Set() };
    }
  } catch { /* unparseable manifest: contributes nothing */ }
  return null;
}

/** All manifests under root: [{ file (root-relative, posix), eco, runtime, dev }]. */
export function scanManifests(root) {
  const out = [];
  let dirs = 0;
  const walk = (dir, depth) => {
    if (dirs++ > MAX_DIRS) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name), depth + 1);
      } else if (isManifestName(e.name)) {
        try {
          const file = join(dir, e.name);
          const m = parseManifest(file, readFileSync(file, "utf8"));
          if (m) out.push({ file: relative(root, file).split("\\").join("/"), ...m });
        } catch { /* unreadable */ }
      }
    }
  };
  if (root) walk(root, 0);
  return out;
}

/** Union per ecosystem: { npm: { runtime:Set, dev:Set, all:Set }, PyPI: {...} }. */
export function projectDeps(root, manifests = scanManifests(root)) {
  const res = { npm: { runtime: new Set(), dev: new Set(), all: new Set() }, PyPI: { runtime: new Set(), dev: new Set(), all: new Set() } };
  for (const m of manifests) {
    for (const n of m.runtime) { res[m.eco].runtime.add(n); res[m.eco].all.add(n); }
    for (const n of m.dev) { res[m.eco].dev.add(n); res[m.eco].all.add(n); }
  }
  return res;
}
