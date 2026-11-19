/**
 * cache.mjs - user-level TTL cache for the package-add checks (D080): ~/.cache/maple/security/.
 *
 * One small JSON file per lookup, keyed by kind + name. Holds only public registry / downloads / OSV answers,
 * never anything secret. Every read and write is best effort: a broken cache is a miss, never an error.
 * Location: $MAPLE_SECURITY_CACHE_DIR (tests), else $XDG_CACHE_HOME/maple/security, else on Windows
 * %LOCALAPPDATA%\maple\cache\security, else ~/.cache/maple/security.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TTL = { registry: 24 * 3_600_000, downloads: 24 * 3_600_000, osv: 6 * 3_600_000 };

export function cacheDir(env = process.env, platform = process.platform) {
  if (env.MAPLE_SECURITY_CACHE_DIR) return env.MAPLE_SECURITY_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, "maple", "security");
  if (platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "maple", "cache", "security");
  return join(homedir(), ".cache", "maple", "security");
}

const fileFor = (dir, kind, key) => join(dir, kind, `${String(key).toLowerCase().replace(/[^a-z0-9._@-]+/g, "_")}.json`);

/** @returns {unknown|undefined} the cached value, or undefined on a miss / expiry / unreadable file */
export function cacheGet(dir, kind, key, ttlMs, now = Date.now()) {
  if (!dir) return undefined;
  try {
    const rec = JSON.parse(readFileSync(fileFor(dir, kind, key), "utf8"));
    if (rec && typeof rec.at === "number" && now - rec.at < ttlMs && now >= rec.at - 60_000) return rec.data;
  } catch { /* miss */ }
  return undefined;
}

export function cacheSet(dir, kind, key, data, now = Date.now()) {
  if (!dir) return;
  try {
    const file = fileFor(dir, kind, key);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ at: now, data }));
  } catch { /* the cache is an optimisation */ }
}

/** get-or-fetch: `load()` runs only on a miss; a throwing load is not cached. */
export async function cached(dir, kind, key, ttlMs, now, load) {
  const hit = cacheGet(dir, kind, key, ttlMs, now);
  if (hit !== undefined) return hit;
  const data = await load();
  cacheSet(dir, kind, key, data, now);
  return data;
}
