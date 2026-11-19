/**
 * add-cmd.mjs - every package an install command would ADD, bare names and dist-tags included (D080 / D086).
 * install-cmd.mjs keeps D064's narrower question (version-pinned npm specs only); this answers "what is being added".
 *
 *   pnpm|npm|yarn|bun add|install|i <names>      ecosystem npm
 *   pip install | uv pip install | uv add | poetry add   ecosystem PyPI
 *
 * -> [{ eco, pm, name, spec, tag, exact, dev, global, manifest }]
 *   spec     the version part as written ("" for a bare name)    exact  the pinned version when `spec` is one
 *   tag      a dist-tag (`@latest`, `@next`)                    dev    -D / --save-dev / --dev / --group dev
 *   global   -g / --global (not a project dependency)           manifest  the command edits a manifest (not pip install)
 * Requirement files (-r), editables (-e), paths, URLs, VCS specs and flags are ignored; `pnpm install` alone adds nothing.
 */
import { NOT_REGISTRY, SEGMENT_SPLIT, SUBCOMMANDS, splitSpecifier, tokenize, valueSkip } from "./install-cmd.mjs";

const NPM_PM = new Set(["pnpm", "npm", "yarn", "bun"]);
const NPM_DEV = new Set(["-D", "--save-dev", "--dev"]);
const NPM_DEV_BUN = new Set(["-d"]); // bun's short dev flag (pnpm/npm -d is something else)
const SUBS = { ...SUBCOMMANDS, bun: ["add", "a", "install", "i"] };

const PY_VALUE_FLAGS = new Set([
  "-r", "--requirement", "-c", "--constraint", "-e", "--editable", "-i", "--index-url", "--extra-index-url", "-f", "--find-links",
  "-t", "--target", "--prefix", "--root", "--python", "-p", "--index", "--default-index", "--group", "-G", "--extra", "--optional",
  "--python-version", "--platform", "--constraints", "--override", "--exclude-newer", "--resolution", "--directory", "--project", "--config-file", "-C",
]);
const PY_PATHISH = /^(?:\.{0,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|\.$|file:|git\+|git:|https?:|ssh:|-)|\.(?:whl|tar\.gz|tgz|zip)$/i;
const PY_REQ = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(\[[^\]]*\])?\s*([<>=!~].*)?$/;

export const normalizePyName = (n) => n.toLowerCase().replace(/[-_.]+/g, "-");

function npmAdds(tokens, pmIdx) {
  const pm = tokens[pmIdx];
  let i = pmIdx + 1;
  while (i < tokens.length && tokens[i].startsWith("-")) i += valueSkip(tokens[i], pm) ? 2 : 1;
  if (!SUBS[pm].includes(tokens[i])) return [];
  const rest = tokens.slice(i + 1);
  const flags = rest.filter((t) => t.startsWith("-"));
  const dev = flags.some((f) => NPM_DEV.has(f) || (pm === "bun" && NPM_DEV_BUN.has(f)));
  const global = flags.some((f) => f === "-g" || f === "--global") || tokens.slice(pmIdx + 1, i).some((f) => f === "-g" || f === "--global");
  const out = [];
  for (let k = 0; k < rest.length; k += 1) {
    const t = rest[k];
    if (t.startsWith("-")) { if (valueSkip(t, pm)) k += 1; continue; }
    if (NOT_REGISTRY.test(t)) continue;
    const parts = splitSpecifier(t) ?? { name: t, spec: "" };
    if (!/^(@[a-z0-9~][\w.~-]*\/)?[\w.~-]+$/i.test(parts.name)) continue;
    let { name, spec } = parts;
    if (spec.startsWith("npm:")) { // alias: the target is what gets installed
      const alias = splitSpecifier(spec.slice(4)) ?? { name: spec.slice(4), spec: "" };
      ({ name, spec } = alias);
    }
    const exact = /^=?v?(\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(spec)?.[1] ?? null;
    const tag = spec && !exact && /^[A-Za-z][\w.-]*$/.test(spec) ? spec : null;
    out.push({ eco: "npm", pm, name, spec, tag, exact, dev, global, manifest: true });
  }
  return out;
}

/** Find where a Python install command starts: returns { pm, from, manifest } or null. */
function pyStart(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (/^(?:pip|pip3|pip\d(?:\.\d+)?)(?:\.exe)?$/i.test(t) && tokens[i + 1] === "install") return { pm: "pip", from: i + 2, manifest: false };
    if (/^(?:python|python3|py)(?:\.exe)?$/i.test(t) && tokens[i + 1] === "-m" && /^pip3?$/.test(tokens[i + 2] ?? "") && tokens[i + 3] === "install") return { pm: "pip", from: i + 4, manifest: false };
    if (/^uv(?:\.exe)?$/i.test(t)) {
      if (tokens[i + 1] === "pip" && tokens[i + 2] === "install") return { pm: "uv", from: i + 3, manifest: false };
      if (tokens[i + 1] === "add") return { pm: "uv", from: i + 2, manifest: true };
    }
    if (/^poetry(?:\.exe)?$/i.test(t) && tokens[i + 1] === "add") return { pm: "poetry", from: i + 2, manifest: true };
  }
  return null;
}

function pyAdds(tokens) {
  const start = pyStart(tokens);
  if (!start) return [];
  const rest = tokens.slice(start.from);
  let dev = false;
  const out = [];
  for (let k = 0; k < rest.length; k += 1) {
    const t = rest[k];
    if (t === "--dev" || t === "-D") { dev = true; continue; }
    if ((t === "--group" || t === "-G") && /^dev/i.test(rest[k + 1] ?? "")) dev = true;
    if (t.startsWith("--group=") && /^dev/i.test(t.slice(8))) dev = true;
    if (t.startsWith("-")) { if (!t.includes("=") && PY_VALUE_FLAGS.has(t)) k += 1; continue; }
    if (PY_PATHISH.test(t)) continue;
    const m = PY_REQ.exec(t.replace(/;.*$/, "").trim()); // drop environment markers
    if (!m) continue;
    const spec = (m[3] ?? "").replace(/\s+/g, "");
    const exact = /^===?(\d[\w.!+-]*)$/.exec(spec)?.[1] ?? null;
    out.push({ eco: "PyPI", pm: start.pm, name: normalizePyName(m[1]), spec, tag: null, exact, dev, global: false, manifest: start.manifest });
  }
  return out.map((a) => ({ ...a, dev }));
}

/** @returns {Array<{eco: string, pm: string, name: string, spec: string, tag: string|null, exact: string|null, dev: boolean, global: boolean, manifest: boolean}>} */
export function parseAdds(command) {
  const found = [];
  for (const segment of String(command).split(SEGMENT_SPLIT)) {
    const tokens = tokenize(segment);
    const pmIdx = tokens.findIndex((t) => NPM_PM.has(t));
    if (pmIdx >= 0 && tokens.slice(0, pmIdx).every((t) => !/^(?:uv|poetry|pip3?)(?:\.exe)?$/i.test(t))) found.push(...npmAdds(tokens, pmIdx));
    found.push(...pyAdds(tokens));
  }
  return found;
}
