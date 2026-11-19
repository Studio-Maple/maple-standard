/** osv.mjs - one batched OSV lookup (https://api.osv.dev/v1/querybatch) for every resolved package of an add (D080/D081). */
import { cacheGet, cacheSet, TTL } from "./cache.mjs";
import { postJson } from "./http.mjs";

const URL_BATCH = "https://api.osv.dev/v1/querybatch";

/**
 * @param {{eco: "npm"|"PyPI", name: string, version: string}[]} pkgs
 * @returns {Promise<Map<string, string[]>>} "eco/name@version" -> vulnerability ids (empty array = clean)
 */
export async function osvLookup(pkgs, { fetchImpl, cacheDir, now, timeoutMs }) {
  const out = new Map();
  const todo = [];
  for (const p of pkgs) {
    const key = `${p.eco}/${p.name}@${p.version}`;
    const hit = cacheGet(cacheDir, "osv", key, TTL.osv, now);
    if (hit !== undefined) out.set(key, hit);
    else if (!out.has(key) && !todo.some((t) => t.key === key)) todo.push({ ...p, key });
  }
  if (todo.length === 0) return out;
  const res = await postJson(fetchImpl, URL_BATCH, { queries: todo.map((p) => ({ package: { name: p.name, ecosystem: p.eco }, version: p.version })) }, { timeoutMs });
  const results = res?.results ?? [];
  if (results.length !== todo.length) throw new Error("osv answered with a different number of results than queries");
  todo.forEach((p, i) => {
    const ids = (results[i]?.vulns ?? []).map((v) => v.id).filter(Boolean);
    out.set(p.key, ids);
    cacheSet(cacheDir, "osv", p.key, ids, now);
  });
  return out;
}
