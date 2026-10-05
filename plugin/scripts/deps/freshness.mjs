/**
 * freshness.mjs — judge one dependency spec against the latest eligible release (D064).
 * Shared by the ci:fast gate (check-dep-freshness.mjs) and the bash-guard install check.
 */
import { findException } from "./exceptions.mjs";
import { classifyDep } from "./pkgjson.mjs";
import { isBehind, rangeFloor } from "./semver-lite.mjs";

/**
 * @param {{name: string, spec: string}} dep dependency key + version spec (as written in package.json / on the command line)
 * @param {{ latestFor: (pkg: string) => Promise<string>, exceptions: object[] }} ctx
 * @returns {Promise<{status: 'ok'|'skipped'|'excepted'|'stale'|'unreachable', latest?: string, reason?: string, decision?: string}>}
 */
export async function judgeDep(dep, ctx) {
  const c = classifyDep(dep.name, dep.spec);
  if (c.skip) return { status: "skipped", reason: c.skip };
  if (!rangeFloor(c.range)) return { status: "ok", reason: "no version floor (tag / wildcard)" };
  let latest;
  try {
    latest = await ctx.latestFor(c.name);
  } catch (err) {
    return { status: "unreachable", reason: err instanceof Error ? err.message : String(err) };
  }
  if (!isBehind(c.range, latest)) return { status: "ok", latest };
  const ex = findException(ctx.exceptions, [dep.name, c.name], c.range);
  if (ex) return { status: "excepted", latest, decision: ex.decision };
  return { status: "stale", latest };
}

/** The one denial/failure sentence, shared so hook and gate say the same thing. */
export function staleMessage(name, spec, latest) {
  return `${name}@${spec} is behind the latest release (${latest}). Don't hand-write dependency versions — run \`pnpm add ${name}\` (dev: \`pnpm add -D ${name}\`) so the registry picks the latest. D064.`;
}
