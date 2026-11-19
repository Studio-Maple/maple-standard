/**
 * package-add.mjs - the add-time package checks (control "packageAdd", D079 / D080 / D081).
 *
 * For every package an install command would add: resolve the version the package manager would install, then
 *   release-age   that version must be older than the cooldown (7 days by default, D079; the project's own
 *                 pnpm/npm cooldown wins when stricter)
 *   osv           no known vulnerability in it (one batched OSV query for the whole command)
 *   reputation    NEW names only (not in any manifest of the project): weekly downloads, first-publish age,
 *                 deprecation, typosquat distance to a bundled top-5000 name
 *   not-found     the registry has no such package (a hallucinated name)
 * Network goes through an injected fetchImpl and the user-level cache (cache.mjs); one 4 s budget per command,
 * requests in parallel. A failed lookup becomes a warning (fail-open, D064): the commit/push OSV check backs it up.
 * deps.exceptions (D###-backed) silence every finding of the package they cover.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheDir as defaultCacheDir } from "./cache.mjs";
import { loadExceptions, findException } from "./exceptions.mjs";
import { budget } from "./http.mjs";
import { osvLookup } from "./osv.mjs";
import { asPackument, npmRecord, pypiRecord, resolveNpm, resolvePypi } from "./pkg-info.mjs";
import { DEFAULT_REGISTRY, pickLatestEligible, readMinReleaseAge, registryUrl } from "./registry.mjs";
import { DEFAULT_REPUTATION, reputationFindings, weeklyDownloads } from "./reputation.mjs";
import { projectDeps } from "./manifests.mjs";
import { isBehind } from "./semver-lite.mjs";

const DEFAULT_RELEASE_AGE_DAYS = 7; // D079

function scopedRegistry(root, name) {
  if (!name.startsWith("@")) return false;
  try {
    const file = join(root, ".npmrc");
    const prefix = `${name.split("/")[0]}:registry`;
    return existsSync(file) && readFileSync(file, "utf8").split(/\r?\n/).some((l) => l.trim().startsWith(prefix));
  } catch {
    return false;
  }
}

/**
 * The release-age finding. Suggesting an exact older pin is only safe when D064's install guard (which judges against
 * the PROJECT's cooldown) would accept it; otherwise the pin is "behind latest" there and the agent would loop between
 * the two guards, so the message points at the project cooldown instead.
 */
function ageMessage(add, r, rec, { guardMin, projectMin, now }) {
  const d = guardMin >= 1440 ? `${Math.round(guardMin / 1440)}-day` : `${guardMin}-minute`;
  const head = `${add.name}@${r.version} was published ${r.ageDays.toFixed(1)} day(s) ago, inside the ${d} release-age cooldown (D079).`;
  if (!r.safe) return `${head} No release has cleared it yet; wait or pick another package.`;
  const newest = add.eco === "npm" ? pickLatestEligible(asPackument(rec), projectMin, now) : rec.latest;
  if (add.eco === "npm" && newest && isBehind(r.safe, newest)) {
    const clears = new Date(Date.parse(r.publishedAt) + guardMin * 60_000).toISOString().slice(0, 10);
    return `${head} The newest release that cleared it (${r.safe}) is an older major than what this project's own cooldown allows, so pinning it would be rejected by the freshness guard (D064). Set the project cooldown (pnpm minimumReleaseAge: 10080 in pnpm-workspace.yaml, or min-release-age=7 in .npmrc; D079) so the package manager resolves it, or wait until ${clears}.`;
  }
  return `${head} Install the newest release that cleared it: ${add.name}@${r.safe}.`;
}

const why = (err) => (err instanceof Error ? err.message : String(err)).slice(0, 160);

/**
 * @param {ReturnType<import("./add-cmd.mjs").parseAdds>} adds
 * @param {string} root project root
 * @param {{ fetchImpl?: typeof fetch, now?: number, cacheDir?: string, budgetMs?: number, topDir?: string,
 *           options?: { minReleaseAgeDays?: number, minWeeklyDownloads?: number, minPackageAgeDays?: number } }} [opts]
 * @returns {Promise<{ findings: {pkg: string, rule: string, message: string}[], warnings: string[] }>}
 */
export async function checkPackageAdds(adds, root, opts = {}) {
  const { fetchImpl = fetch, now = Date.now(), cacheDir = defaultCacheDir(), budgetMs = 4000, topDir, options = {} } = opts;
  const findings = [];
  const warnings = [];
  const unique = [...new Map(adds.map((a) => [`${a.eco}/${a.name}@${a.spec}`, a])).values()];
  if (unique.length === 0) return { findings, warnings };

  const rep = { ...DEFAULT_REPUTATION, ...(options.minWeeklyDownloads !== undefined && { minWeeklyDownloads: options.minWeeklyDownloads }), ...(options.minPackageAgeDays !== undefined && { minPackageAgeDays: options.minPackageAgeDays }) };
  const projectMin = readMinReleaseAge(root);
  const guardMin = Math.max(Math.round((options.minReleaseAgeDays ?? DEFAULT_RELEASE_AGE_DAYS) * 1440), projectMin);
  const known = projectDeps(root);
  const { valid } = loadExceptions(root);
  const bud = budget(budgetMs);
  const net = () => ({ fetchImpl, cacheDir, now, timeoutMs: bud.remaining() });
  const registryIsDefault = registryUrl() === DEFAULT_REGISTRY;

  const facts = await Promise.all(unique.map(async (add) => {
    const isNew = !known[add.eco].all.has(add.name.toLowerCase()); // network calls keep the name as written (legacy mixed-case packages)
    const label = `${add.name}${add.spec ? `@${add.spec}` : ""}`;
    let dlError = null;
    try {
      const [rec, downloads] = await Promise.all([
        add.eco === "npm" ? npmRecord(add.name, net()) : pypiRecord(add.name, net()),
        isNew ? weeklyDownloads(add.eco, add.name, net()).catch((e) => { dlError = e; return null; }) : null,
      ]);
      if (dlError && dlError.status !== 404) warnings.push(`package-add: downloads for ${add.name} unavailable (${why(dlError)}); reputation check skipped.`);
      return { add, rec, downloads, isNew, label };
    } catch (err) {
      if (err?.status === 404) {
        if (add.eco === "PyPI" || (registryIsDefault && !scopedRegistry(root, add.name))) findings.push({ pkg: add.name, rule: "not-found", message: `${label} does not exist on ${add.eco === "npm" ? "the npm registry" : "PyPI"} — check the name (a made-up package name is how dependency-confusion attacks start).` });
        return null;
      }
      warnings.push(`package-add: could not verify ${label} (${why(err)}); allowed — the commit/push OSV check will look at it.`);
      return null;
    }
  }));

  const resolved = [];
  for (const f of facts.filter(Boolean)) {
    const { add, rec } = f;
    const r = add.eco === "npm" ? resolveNpm(rec, add, { projectMin, guardMin, now }) : resolvePypi(rec, add, { guardMin, now });
    if (r.young) findings.push({ pkg: add.name, rule: "release-age", message: ageMessage(add, r, rec, { guardMin, projectMin, now }) });
    if (r.version) resolved.push({ add, version: r.version });
    if (f.isNew) {
      const deprecated = add.eco === "npm" ? (r.version && rec.deprecated[r.version]) || null : rec.inactive ? true : null;
      findings.push(...reputationFindings(add, { downloads: f.downloads, created: rec.created, deprecated }, rep, now, topDir).map((x) => ({ pkg: add.name, ...x })));
    }
  }

  if (resolved.length) {
    try {
      const res = await osvLookup(resolved.map((x) => ({ eco: x.add.eco, name: x.add.name, version: x.version })), net());
      for (const x of resolved) {
        const ids = res.get(`${x.add.eco}/${x.add.name}@${x.version}`) ?? [];
        if (ids.length) findings.push({ pkg: x.add.name, rule: "osv", message: `${x.add.name}@${x.version} has known vulnerabilit${ids.length === 1 ? "y" : "ies"} (OSV): ${ids.slice(0, 6).join(", ")}${ids.length > 6 ? ` (+${ids.length - 6} more)` : ""}.` });
      }
    } catch (err) {
      warnings.push(`package-add: OSV lookup failed (${why(err)}); vulnerabilities not checked — the commit/push OSV check is the backstop.`);
    }
  }

  const covered = new Set(unique.filter((a) => findException(valid, [a.name], resolved.find((x) => x.add === a)?.version ?? a.exact ?? a.spec ?? "")).map((a) => a.name));
  return { findings: findings.filter((f) => !covered.has(f.pkg)), warnings };
}

/** One deny string for a findings list (null when empty). */
export function formatFindings(findings) {
  if (!findings.length) return null;
  return `package-add guard (D080): ${findings.map((f) => `[${f.rule}] ${f.message}`).join(" ")} To proceed anyway, record a decision and add a deps.exceptions entry for the package (maple.config.json).`;
}
