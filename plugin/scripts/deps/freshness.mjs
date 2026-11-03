/**
 * freshness.mjs — judge one dependency spec against the latest eligible release (D064).
 * Shared by the ci:fast gate (check-dep-freshness.mjs) and the bash-guard install check.
 *
 * "Eligible" means past the project's release-age cooldown (registry.mjs readMinReleaseAge), so the newest
 * release can never be both required (not stale) and forbidden (too new). Two failure verdicts:
 *   stale   the spec is behind the newest ELIGIBLE release's major (0.x: minor)
 *   cooling an exact pin whose release is younger than the cooldown (needs ctx.cooldown)
 */
import { findException } from "./exceptions.mjs";
import { classifyDep } from "./pkgjson.mjs";
import { describeCooldown } from "./registry.mjs";
import { isBehind, rangeFloor } from "./semver-lite.mjs";

const EXACT = /^=?\s*v?(\d+\.\d+\.\d+)$/;

/**
 * @param {{name: string, spec: string}} dep dependency key + version spec (as written in package.json / on the command line)
 * @param {{ latestFor: (pkg: string) => Promise<string>, exceptions: object[],
 *           cooldown?: { minutes: number, now?: number, publishedAtFor: (pkg: string, version: string) => Promise<string|undefined> } }} ctx
 * @returns {Promise<{status: 'ok'|'skipped'|'excepted'|'stale'|'cooling'|'unreachable', latest?: string, reason?: string, decision?: string, version?: string, until?: string}>}
 */
export async function judgeDep(dep, ctx) {
  const c = classifyDep(dep.name, dep.spec);
  if (c.skip) return { status: "skipped", reason: c.skip };
  if (!rangeFloor(c.range)) return { status: "ok", reason: "no version floor (tag / wildcard)" };
  let latest;
  let publishedAt;
  try {
    latest = await ctx.latestFor(c.name);
    const exact = EXACT.exec(c.range.trim())?.[1];
    if (exact && ctx.cooldown?.minutes > 0) publishedAt = await ctx.cooldown.publishedAtFor(c.name, exact);
  } catch (err) {
    return { status: "unreachable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!isBehind(c.range, latest)) {
    const until = publishedAt ? Date.parse(publishedAt) + ctx.cooldown.minutes * 60_000 : NaN;
    if (Number.isFinite(until) && until > (ctx.cooldown.now ?? Date.now())) {
      return { status: "cooling", latest, version: EXACT.exec(c.range.trim())[1], until: new Date(until).toISOString() };
    }
    return { status: "ok", latest };
  }
  const ex = findException(ctx.exceptions, [dep.name, c.name], c.range);
  if (ex) return { status: "excepted", latest, decision: ex.decision };
  return { status: "stale", latest };
}

/**
 * The one denial/failure sentence, shared so hook and gate say the same thing. With a cooldown the newest
 * eligible release is named together with the cooldown (it is NOT necessarily npm `latest`).
 */
export function staleMessage(name, spec, latest, cooldownMinutes = 0) {
  if (cooldownMinutes > 0) {
    return `${name}@${spec} is behind the newest release that has passed this project's ${describeCooldown(cooldownMinutes)} release-age cooldown (${latest}). Don't hand-write dependency versions — install ${name}@${latest} (or run \`pnpm add ${name}\`, which resolves the same version); newer releases are still in cooldown. D064.`;
  }
  return `${name}@${spec} is behind the latest release (${latest}). Don't hand-write dependency versions — run \`pnpm add ${name}\` (dev: \`pnpm add -D ${name}\`) so the registry picks the latest. D064.`;
}

/** An exact pin of a release that is still inside the cooldown window. */
export function coolingMessage(name, spec, { version, until, latest }, cooldownMinutes) {
  return `${name}@${spec} (${version}) is still in this project's ${describeCooldown(cooldownMinutes)} release-age cooldown until ${until.slice(0, 16).replace("T", " ")} UTC; the newest release that has passed it is ${name}@${latest}. Use that, or wait. D064.`;
}
