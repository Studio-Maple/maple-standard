/**
 * install-guard.mjs — bash-guard's dependency-install check (D064).
 *
 * `pnpm add react@17` style installs with an explicit version are looked up against the registry;
 * a pin behind the latest major (0.x: minor) is denied. Bare names and dist-tags install the latest
 * already, so they pass without a lookup. A registry failure ALLOWS with a warning — the ci:fast
 * freshness gate is the backstop, and a flaky network must not wedge every install.
 */
import { loadExceptions } from "./exceptions.mjs";
import { judgeDep, staleMessage } from "./freshness.mjs";
import { parseInstallSpecs } from "./install-cmd.mjs";
import { fetchLatestEligible, readMinReleaseAge } from "./registry.mjs";

/** @returns {Promise<{ deny: string|null, warnings: string[] }>} */
export async function checkInstallCommand(command, root, { fetchImpl = fetch, timeoutMs = 4000, now } = {}) {
  const specs = parseInstallSpecs(command);
  if (specs.length === 0) return { deny: null, warnings: [] };
  const { valid, problems } = loadExceptions(root);
  const minAgeMinutes = readMinReleaseAge(root);
  const cache = new Map();
  const latestFor = (pkg) => {
    if (!cache.has(pkg)) cache.set(pkg, fetchLatestEligible(pkg, { minAgeMinutes, fetchImpl, timeoutMs, now }));
    return cache.get(pkg);
  };
  const results = await Promise.all(specs.map(async (s) => ({ s, r: await judgeDep({ name: s.name, spec: s.spec }, { latestFor, exceptions: valid }) })));
  const denials = results.filter(({ r }) => r.status === "stale").map(({ s, r }) => staleMessage(s.name, s.spec, r.latest));
  const warnings = results
    .filter(({ r }) => r.status === "unreachable")
    .map(({ s, r }) => `dep-freshness: could not verify ${s.name}@${s.spec} (${r.reason}); allowed — the ci:fast gate will check it.`);
  if (denials.length && problems.length) denials.push(`Exception list problems: ${problems.join(" | ")}`);
  return { deny: denials.length ? denials.join("\n") : null, warnings };
}
