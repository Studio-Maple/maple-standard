/**
 * edit-distance.mjs - typosquat detection (D080): Damerau-Levenshtein distance (optimal string alignment: insert,
 * delete, substitute, adjacent transposition each cost 1) of a new package name against a bundled top-N list.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "data");

export function distance(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2] + 1);
      cur[j] = d;
    }
    prev2.length = 0;
    prev2.push(...prev);
    prev = cur;
  }
  return prev[b.length];
}

const lists = new Map();
/** The bundled popular names for an ecosystem ("npm" | "PyPI"). Empty (never throws) when the file is missing. */
export function topNames(eco, dir = DATA) {
  const file = eco === "npm" ? "top-npm.json" : "top-pypi.json";
  const key = join(dir, file);
  if (!lists.has(key)) {
    let names = [];
    try { names = JSON.parse(readFileSync(key, "utf8")).names ?? []; } catch { /* no list: no typosquat finding */ }
    lists.set(key, { names, set: new Set(names) });
  }
  return lists.get(key);
}

/**
 * The popular names within distance 1..2 of `name` (never `name` itself). Names shorter than 4 chars are exempt
 * (every 3-letter name is within 2 edits of something popular). Scoped names are compared whole.
 */
export function typosquatOf(name, eco, dir) {
  const { names, set } = topNames(eco, dir);
  const n = name.toLowerCase();
  if (set.has(n) || n.length < 4) return [];
  const out = [];
  for (const top of names) {
    if (Math.abs(top.length - n.length) > 2) continue;
    const d = distance(n, top, 2);
    if (d >= 1 && d <= 2) out.push({ name: top, distance: d });
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, 3);
}
