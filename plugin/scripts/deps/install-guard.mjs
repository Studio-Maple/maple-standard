/**
 * install-guard.mjs — bash-guard's dependency-install check (D064).
 *
 * `pnpm add react@17` style installs with an explicit version are looked up against the registry;
 * a pin behind the newest ELIGIBLE release's major (0.x: minor) is denied. Eligible = past the project's
 * release-age cooldown (registry.mjs readMinReleaseAge: pnpm-workspace.yaml / .npmrc, the same value the
 * ci:fast gate and the package manager use), so a release the cooldown forbids is never demanded. An exact
 * pin of a release still inside the cooldown is denied too, naming the date it clears and the newest
 * eligible version. Bare names and dist-tags install the latest already (the package manager applies the
 * cooldown itself), so they pass without a lookup.
 *
 * Global installs (`npm i -g`, `pnpm add -g`) ARE checked, deliberately: they are not repo dependencies, but
 * the failure D064 targets (a version written from training memory, so outdated) is identical, and the
 * cooldown is the owner's supply-chain posture rather than a per-manifest property. npm reads the
 * project's .npmrc for `-g` too. Outside a project (no cooldown configured) the comparison is against
 * the registry's `latest`.
 *
 * A registry failure ALLOWS with a warning — the ci:fast freshness gate is the backstop, and a flaky
 * network must not wedge every install.
 */
import { loadExceptions } from "./exceptions.mjs";
import { coolingMessage, judgeDep, staleMessage } from "./freshness.mjs";
import { parseInstallSpecs } from "./install-cmd.mjs";
import { fetchEligibility, readMinReleaseAge } from "./registry.mjs";

/** @returns {Promise<{ deny: string|null, warnings: string[] }>} */
export async function checkInstallCommand(command, root, { fetchImpl = fetch, timeoutMs = 4000, now } = {}) {
  const specs = parseInstallSpecs(command);
  if (specs.length === 0) return { deny: null, warnings: [] };
  const { valid, problems } = loadExceptions(root);
  const minAgeMinutes = readMinReleaseAge(root);
  const cache = new Map();
  const infoFor = (pkg) => {
    if (!cache.has(pkg)) cache.set(pkg, fetchEligibility(pkg, { minAgeMinutes, fetchImpl, timeoutMs, now }));
    return cache.get(pkg);
  };
  const ctx = {
    latestFor: async (pkg) => (await infoFor(pkg)).latest,
    exceptions: valid,
    cooldown: { minutes: minAgeMinutes, now, publishedAtFor: async (pkg, version) => (await infoFor(pkg)).time[version] },
  };
  const results = await Promise.all(specs.map(async (s) => ({ s, r: await judgeDep({ name: s.name, spec: s.spec }, ctx) })));
  const denials = results.flatMap(({ s, r }) => {
    if (r.status === "stale") return [staleMessage(s.name, s.spec, r.latest, minAgeMinutes)];
    if (r.status === "cooling") return [coolingMessage(s.name, s.spec, r, minAgeMinutes)];
    return [];
  });
  const warnings = results
    .filter(({ r }) => r.status === "unreachable")
    .map(({ s, r }) => `dep-freshness: could not verify ${s.name}@${s.spec} (${r.reason}); allowed — the ci:fast gate will check it.`);
  if (denials.length && problems.length) denials.push(`Exception list problems: ${problems.join(" | ")}`);
  return { deny: denials.length ? denials.join("\n") : null, warnings };
}
