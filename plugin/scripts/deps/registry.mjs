/**
 * registry.mjs — "what is the latest release I may actually install" (D064).
 *
 * latest eligible = the registry's `latest` dist-tag, unless pnpm's `minimumReleaseAge` (minutes,
 * pnpm-workspace.yaml) is set and that release is younger than the window — then the highest
 * non-prerelease version published longer ago than the window (the same version pnpm would resolve).
 * The network call is injectable (`fetchImpl`) so tests never touch the registry.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, isPrerelease, parseVersion } from "./semver-lite.mjs";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const ABBREVIATED = "application/vnd.npm.install-v1+json";

export function registryUrl(env = process.env) {
  return (env.npm_config_registry || env.NPM_CONFIG_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/, "");
}

/** pnpm `minimumReleaseAge` (minutes) from `<root>/pnpm-workspace.yaml`; 0 when unset. */
export function readMinReleaseAge(root) {
  const file = join(root, "pnpm-workspace.yaml");
  if (!existsSync(file)) return 0;
  try {
    const m = /^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/m.exec(readFileSync(file, "utf8"));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Pick the latest eligible version from a packument. With no age window this is the `latest` dist-tag;
 * with one it needs the packument's `time` map (full document, not the abbreviated one).
 * @returns {string|null} null when nothing is old enough
 */
export function pickLatestEligible(packument, minAgeMinutes = 0, now = Date.now()) {
  const tag = packument?.["dist-tags"]?.latest;
  if (!minAgeMinutes) return tag ?? null;
  const cutoff = now - minAgeMinutes * 60_000;
  const old = (v) => {
    const t = Date.parse(packument?.time?.[v]);
    return Number.isFinite(t) && t <= cutoff;
  };
  if (tag && !isPrerelease(tag) && old(tag)) return tag;
  const eligible = Object.keys(packument?.versions ?? {}).filter((v) => parseVersion(v) && !isPrerelease(v) && old(v));
  if (eligible.length === 0) return null;
  return eligible.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best));
}

/** Fetch the latest eligible version of a package. Throws on any network / registry failure. */
export async function fetchLatestEligible(name, { registry = registryUrl(), minAgeMinutes = 0, fetchImpl = fetch, timeoutMs = 4000, now } = {}) {
  const url = `${registry}/${name.replace("/", "%2f")}`;
  const res = await fetchImpl(url, {
    headers: { accept: minAgeMinutes ? "application/json" : ABBREVIATED },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`registry answered ${res.status} for ${name}`);
  const version = pickLatestEligible(await res.json(), minAgeMinutes, now);
  if (!version) throw new Error(`no release of ${name} is older than minimumReleaseAge (${minAgeMinutes} min)`);
  return version;
}
