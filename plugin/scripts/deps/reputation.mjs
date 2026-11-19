/**
 * reputation.mjs - weak-reputation checks for a NEW package name (D080): weekly downloads, first publish age,
 * deprecation, typosquat. Pure rules over already-fetched facts; the downloads call is the only extra network
 * (npm downloads API / pypistats), cached 24 h.
 */
import { cached, TTL } from "./cache.mjs";
import { getJson } from "./http.mjs";
import { typosquatOf } from "./edit-distance.mjs";

export const DEFAULT_REPUTATION = { minWeeklyDownloads: 1000, minPackageAgeDays: 30 };

export async function weeklyDownloads(eco, name, { fetchImpl, cacheDir, now, timeoutMs }) {
  return cached(cacheDir, eco === "npm" ? "npm-downloads" : "pypi-downloads", name, TTL.downloads, now, async () => {
    if (eco === "npm") {
      const d = await getJson(fetchImpl, `https://api.npmjs.org/downloads/point/last-week/${name}`, { timeoutMs });
      return Number(d.downloads) || 0;
    }
    const d = await getJson(fetchImpl, `https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`, { timeoutMs });
    return Number(d?.data?.last_week) || 0;
  });
}

/**
 * @param {{eco: string, name: string}} add
 * @param {{downloads: number|null, created: string|null, deprecated: string|null}} facts  null = unknown (not judged)
 * @returns {{rule: string, message: string}[]}
 */
export function reputationFindings(add, facts, { minWeeklyDownloads, minPackageAgeDays }, now, topDir) {
  const out = [];
  const tag = `${add.name}`;
  if (facts.downloads !== null && facts.downloads < minWeeklyDownloads) {
    out.push({ rule: "downloads", message: `${tag} has only ${facts.downloads} weekly downloads (minimum ${minWeeklyDownloads}) — a brand-new or unused package is a supply-chain risk.` });
  }
  const created = facts.created ? Date.parse(facts.created) : NaN;
  if (Number.isFinite(created) && now - created < minPackageAgeDays * 86_400_000) {
    out.push({ rule: "package-age", message: `${tag} was first published ${Math.max(0, Math.floor((now - created) / 86_400_000))} day(s) ago (minimum ${minPackageAgeDays}).` });
  }
  if (facts.deprecated) out.push({ rule: "deprecated", message: `${tag} is deprecated${facts.deprecated === true ? "" : `: ${String(facts.deprecated).slice(0, 120)}`}.` });
  const squat = typosquatOf(add.name, add.eco, topDir);
  if (squat.length) {
    out.push({ rule: "typosquat", message: `${tag} is within edit distance ${squat[0].distance} of the popular package ${squat.map((s) => s.name).join(" / ")} — a likely typo or typosquat. Check the spelling.` });
  }
  return out;
}
