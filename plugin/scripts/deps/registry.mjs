/**
 * registry.mjs — "what is the latest release I may actually install" (D064).
 *
 * latest eligible = the registry's `latest` dist-tag, unless the project's release-age cooldown is set and
 * that release is younger than the window — then the highest non-prerelease version published longer ago
 * than the window (the same version the package manager would resolve). The cooldown is read from the
 * project root by readMinReleaseAge: pnpm `minimumReleaseAge` (minutes, pnpm-workspace.yaml), pnpm
 * `minimum-release-age` (minutes) and npm `min-release-age` (DAYS) in .npmrc; the strictest wins, so the
 * guards, the ci:fast gate and the package manager itself can never disagree about what is too new.
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

/**
 * The project's release-age cooldown in MINUTES (0 = none). Sources under `root`, strictest wins:
 * pnpm-workspace.yaml `minimumReleaseAge` (minutes); .npmrc `minimum-release-age` (minutes, pnpm) and
 * `min-release-age` (days, npm >= 11.10).
 */
export function readMinReleaseAge(root) {
  const read = (name) => {
    try {
      const file = join(root, name);
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    } catch {
      return "";
    }
  };
  const minutes = (re, text, perUnit) => {
    const m = re.exec(text);
    return m ? Number(m[1]) * perUnit : 0;
  };
  const npmrc = read(".npmrc");
  return Math.round(
    Math.max(
      minutes(/^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/m, read("pnpm-workspace.yaml"), 1),
      minutes(/^\s*minimum[-_]release[-_]age\s*=\s*(\d+)\s*(?:[#;].*)?$/m, npmrc, 1),
      minutes(/^\s*min[-_]release[-_]age\s*=\s*(\d+(?:\.\d+)?)\s*(?:[#;].*)?$/m, npmrc, 1440),
    ),
  );
}

/** "7-day" / "24-hour" / "90-minute": the cooldown window in words, for messages. */
export function describeCooldown(minutes) {
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
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

/**
 * Fetch a package's latest eligible version plus its publish times (`time`: version -> ISO date; {} without a
 * window, where the abbreviated document carries none). Throws on any network / registry failure, or when
 * nothing is old enough.
 * @returns {Promise<{ latest: string, time: Record<string, string> }>}
 */
export async function fetchEligibility(name, { registry = registryUrl(), minAgeMinutes = 0, fetchImpl = fetch, timeoutMs = 4000, now } = {}) {
  const url = `${registry}/${name.replace("/", "%2f")}`;
  const res = await fetchImpl(url, {
    headers: { accept: minAgeMinutes ? "application/json" : ABBREVIATED },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`registry answered ${res.status} for ${name}`);
  const packument = await res.json();
  const latest = pickLatestEligible(packument, minAgeMinutes, now);
  if (!latest) throw new Error(`no release of ${name} is older than the ${describeCooldown(minAgeMinutes)} release-age cooldown (${minAgeMinutes} min)`);
  return { latest, time: packument?.time ?? {} };
}

/** Fetch the latest eligible version of a package. Throws on any network / registry failure. */
export async function fetchLatestEligible(name, opts) {
  return (await fetchEligibility(name, opts)).latest;
}
