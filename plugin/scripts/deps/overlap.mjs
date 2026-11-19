/**
 * overlap.mjs - what a new dependency overlaps with, found without a model call (D086): the bundled capability map
 * (data/capabilities.json: groups of packages that do the same job, plus the platform feature that often replaces
 * them) and a shared name stem with an existing dependency.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");
let mapCache = null;

export function capabilityGroups(dir = DATA) {
  if (!mapCache || mapCache.dir !== dir) {
    let groups = {};
    try { groups = JSON.parse(readFileSync(join(dir, "capabilities.json"), "utf8")).groups ?? {}; } catch { /* no map: no overlap hints */ }
    mapCache = { dir, groups };
  }
  return mapCache.groups;
}

const GENERIC = new Set(["react", "node", "types", "type", "plugin", "plugins", "eslint", "prettier", "config", "configs", "next", "core", "utils", "util", "test", "tests", "with", "babel", "webpack", "vite", "postcss", "loader", "preset", "native", "dom", "server", "client", "http", "json", "web", "lint", "api", "lib", "tools", "tool", "kit", "base", "common", "shared", "supabase", "python", "pytest", "django", "flask"]);
const tokens = (n) => n.toLowerCase().replace(/^@[^/]+\//, "").split(/[-_./]+/).filter((t) => t.length >= 4 && !GENERIC.has(t));

/**
 * @param {string} name new package   @param {"npm"|"PyPI"} eco   @param {Iterable<string>} existing current direct dependency names
 * @returns {{ groups: {group: string, existing: string[], platform: string}[], stems: {name: string, token: string}[] }}
 */
export function findOverlap(name, eco, existing, dir) {
  const have = [...existing].filter((e) => e !== name);
  const n = name.toLowerCase();
  const groups = [];
  for (const [group, g] of Object.entries(capabilityGroups(dir))) {
    if (g.eco !== eco || !g.members.includes(n)) continue;
    groups.push({ group, existing: have.filter((e) => g.members.includes(e.toLowerCase())), platform: g.platform });
  }
  const mine = new Set(tokens(n));
  const stems = [];
  for (const e of have) {
    const shared = tokens(e).find((t) => mine.has(t));
    if (shared) stems.push({ name: e, token: shared });
  }
  return { groups, stems: stems.slice(0, 5) };
}

export function describeOverlap(name, ov) {
  const lines = [];
  for (const g of ov.groups) {
    lines.push(g.existing.length
      ? `${name} does the same job as ${g.existing.join(", ")} already in this project (${g.group}); platform alternative: ${g.platform}.`
      : `${name} is in the "${g.group}" family; platform alternative to consider first: ${g.platform}.`);
  }
  if (ov.stems.length) lines.push(`${name} shares a name stem with ${ov.stems.map((s) => `${s.name} ("${s.token}")`).join(", ")} - check it is not a duplicate.`);
  return lines;
}
