/**
 * pkgjson.mjs — package.json dependency-map diffing and spec classification (D064).
 * Pure functions; no I/O, no network.
 */

export const DEP_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const SKIP_PREFIX = /^(workspace:|file:|link:|portal:|catalog:|git\+|git:|github:|gitlab:|bitbucket:|gist:|https?:|ssh:)/i;

/** Flatten the four dependency maps to `[section, name, spec]` rows. Non-object / non-string entries are ignored. */
export function depRows(pkg) {
  const rows = [];
  if (!pkg || typeof pkg !== "object") return rows;
  for (const section of DEP_SECTIONS) {
    const map = pkg[section];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [name, spec] of Object.entries(map)) if (typeof spec === "string") rows.push([section, name, spec]);
  }
  return rows;
}

/** Dependencies ADDED or whose spec CHANGED between two parsed package.json objects (removals are ignored). */
export function diffDeps(before, after) {
  const prior = new Map(depRows(before).map(([section, name, spec]) => [`${section}\0${name}`, spec]));
  const changed = [];
  for (const [section, name, spec] of depRows(after)) {
    const was = prior.get(`${section}\0${name}`);
    if (was !== spec) changed.push({ section, name, spec, was: was ?? null });
  }
  return changed;
}

/**
 * Classify a dependency entry. Returns `{ skip: <reason> }` for specs that are not registry versions
 * (workspace/file/link/git/url), otherwise `{ name, range }` with `npm:` aliases resolved to their target
 * (`"a": "npm:b@^2"` -> `{ name: "b", range: "^2" }`).
 */
export function classifyDep(name, spec) {
  const text = String(spec).trim();
  if (SKIP_PREFIX.test(text)) return { skip: "non-registry spec" };
  if (/^[\w.-]+\/[\w.-]+(#.*)?$/.test(text)) return { skip: "git shorthand" }; // user/repo
  if (text.toLowerCase().startsWith("npm:")) {
    const target = text.slice(4);
    const at = target.lastIndexOf("@");
    if (at > 0) return { name: target.slice(0, at), range: target.slice(at + 1) };
    return { name: target, range: "" };
  }
  return { name, range: text };
}

/**
 * Apply an Edit / MultiEdit / Write tool call to the file's current content and return the content
 * it would have afterwards, or null when it cannot be computed (an old_string not found is the
 * tool's own error to report, so it is not ours to deny).
 */
export function applyToolEdit(toolName, input, current) {
  if (toolName === "Write") return typeof input.content === "string" ? input.content : null;
  const edits = toolName === "MultiEdit" ? input.edits : [input];
  if (!Array.isArray(edits)) return null;
  let text = current;
  for (const e of edits) {
    if (typeof e?.old_string !== "string" || typeof e?.new_string !== "string") return null;
    if (!text.includes(e.old_string)) return null;
    text = e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string);
  }
  return text;
}
