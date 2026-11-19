/**
 * pkg-info.mjs - slim, cached facts about a package from its registry (npm packument / PyPI JSON API) and the
 * version an add would resolve to under the release-age cooldown (D079). Every network call goes through the
 * injected fetchImpl and the 24 h cache; a cache hit makes no request. Throws HttpError / network errors.
 */
import { cached, TTL } from "./cache.mjs";
import { getJson } from "./http.mjs";
import { DEFAULT_REGISTRY, pickLatestEligible, registryUrl } from "./registry.mjs";

const DAY_MS = 86_400_000;

const hostKind = (reg) => (reg === DEFAULT_REGISTRY ? "npm" : `npm-${reg.replace(/[^a-z0-9]+/gi, "_").slice(0, 40)}`);

/** @returns {Promise<{latest: string, tags: Record<string,string>, times: Record<string,string>, created: string|null, deprecated: Record<string,string>}>} */
export async function npmRecord(name, { fetchImpl, cacheDir, now, timeoutMs, registry = registryUrl() }) {
  return cached(cacheDir, hostKind(registry), name, TTL.registry, now, async () => {
    const p = await getJson(fetchImpl, `${registry}/${name.replace("/", "%2f")}`, { timeoutMs });
    const times = { ...(p.time ?? {}) };
    const created = times.created ?? null;
    delete times.created;
    delete times.modified;
    const deprecated = {};
    for (const [v, meta] of Object.entries(p.versions ?? {})) if (meta?.deprecated) deprecated[v] = String(meta.deprecated).slice(0, 200);
    return { latest: p["dist-tags"]?.latest ?? null, tags: p["dist-tags"] ?? {}, times, created, deprecated };
  });
}

export const asPackument = (rec) => ({ "dist-tags": { latest: rec.latest }, versions: Object.fromEntries(Object.keys(rec.times).map((v) => [v, {}])), time: rec.times });

/**
 * Which npm version would this add install, and how old is it?
 * `wouldInstall`: what the package manager resolves given the PROJECT's own cooldown (bare name -> latest eligible,
 * exact pin -> that pin, dist-tag -> the tag). `safe`: newest release past the GUARD's cooldown (the suggestion).
 * Ranges are resolved to `safe` and not age-checked (same as D064).
 */
export function resolveNpm(rec, add, { projectMin, guardMin, now }) {
  const pack = asPackument(rec);
  const safe = pickLatestEligible(pack, guardMin, now);
  let version = null;
  let checkAge = true;
  if (add.exact) version = add.exact;
  else if (add.tag) version = rec.tags[add.tag] ?? null;
  else if (!add.spec) version = pickLatestEligible(pack, projectMin, now);
  else { version = safe; checkAge = false; }
  return finish(rec.times, version, safe, checkAge, guardMin, now);
}

/** @returns {Promise<{latest: string|null, times: Record<string,string>, yanked: string[], created: string|null, inactive: boolean}>} */
export async function pypiRecord(name, { fetchImpl, cacheDir, now, timeoutMs }) {
  return cached(cacheDir, "pypi", name, TTL.registry, now, async () => {
    const p = await getJson(fetchImpl, `https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { timeoutMs });
    const times = {};
    const yanked = [];
    for (const [v, files] of Object.entries(p.releases ?? {})) {
      const ups = (files ?? []).map((f) => f.upload_time_iso_8601 ?? f.upload_time).filter(Boolean).map((t) => (/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`)).sort();
      if (ups.length) times[v] = ups[0];
      if ((files ?? []).length && files.every((f) => f.yanked)) yanked.push(v);
    }
    const created = Object.values(times).sort()[0] ?? null;
    const inactive = (p.info?.classifiers ?? []).some((c) => /Development Status :: 7 - Inactive/i.test(c));
    return { latest: p.info?.version ?? null, times, yanked, created, inactive };
  });
}

const cmpNums = (a, b) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** PyPI: pip has no cooldown, so a bare name installs `latest` (the project has no PyPI cooldown to apply). */
export function resolvePypi(rec, add, { guardMin, now }) {
  const cutoff = now - guardMin * 60_000;
  const old = Object.keys(rec.times).filter((v) => /^\d+(\.\d+)*$/.test(v) && !rec.yanked.includes(v) && Date.parse(rec.times[v]) <= cutoff);
  const safe = old.length ? old.reduce((b, v) => (cmpNums(v, b) > 0 ? v : b)) : null;
  const exact = add.exact;
  const checkAge = Boolean(exact) || !add.spec;
  const version = exact ?? (add.spec ? safe : rec.latest);
  return finish(rec.times, version, safe, checkAge, guardMin, now);
}

function finish(times, version, safe, checkAge, guardMin, now) {
  const at = version ? Date.parse(times[version]) : NaN;
  const ageDays = Number.isFinite(at) ? (now - at) / DAY_MS : null;
  const young = checkAge && ageDays !== null && now - at < guardMin * 60_000;
  return { version, safe, publishedAt: Number.isFinite(at) ? new Date(at).toISOString() : null, ageDays, young };
}

