// Guard for Write|Edit|MultiEdit (D065 dispatcher) — D064: dependency versions are never hand-written.
//
// Agents write dependency versions from training memory, so they land outdated. When the target is a
// package.json, the dependency maps (dependencies / devDependencies / peerDependencies /
// optionalDependencies) are compared before vs after the edit; any dependency ADDED or whose version
// spec CHANGED is denied — `pnpm add <pkg>` lets the registry pick the latest (and pnpm's
// minimumReleaseAge keeps that safe). Removals, non-dependency edits (scripts, config fields) and
// non-registry specs (workspace:/file:/link:/catalog:/git/url, dist-tags, `*`) pass; so does
// unparseable JSON (other tooling will complain). A dependency covered by a decision-backed exception
// (maple.config.json deps.exceptions, each citing a D### in the decisions ledger) passes too.
// No network: the freshness itself is checked by `pnpm add` + the ci:fast gate.
// D086 (control "necessity"): an edit that passes the above but adds a dependency KEY nothing in the project declares
// yet (a tag / `*` spec, an exception, a git spec) needs a complete deps-ledger.json entry; warn or deny per D082.
//
// Hook errors never block.

import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { findException, loadExceptions } from "../../scripts/deps/exceptions.mjs";
import { checkNecessity } from "../../scripts/deps/necessity.mjs";
import { applyToolEdit, classifyDep, diffDeps } from "../../scripts/deps/pkgjson.mjs";
import { rangeFloor } from "../../scripts/deps/semver-lite.mjs";
import { applyMode } from "./security-mode.mjs";

const TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Dependencies this edit adds / re-specs that are neither exempt by kind nor by a valid exception. */
export function offendingDeps(before, after, valid) {
  return diffDeps(before, after).filter((d) => {
    const c = classifyDep(d.name, d.spec);
    if (c.skip || !rangeFloor(c.range)) return false; // not a registry version
    return !findException(valid, [d.name, c.name], c.range);
  });
}

export function denialReason(offenders, problems) {
  const list = offenders.map((d) => `${d.name}@${d.spec}`).join(", ");
  let reason = `Don't hand-write dependency versions (${list}) — run \`pnpm add <pkg>\` (dev: \`pnpm add -D <pkg>\`) so the registry picks the latest. D064.`;
  if (problems.length) reason += ` Exception list problems: ${problems.join(" | ")}`;
  return reason;
}

/** The package.json edit as { root, before, after } parsed objects, or null when it is not a computable package.json edit. */
function parseEdit(payload) {
  const tool = payload?.tool_name;
  const input = payload?.tool_input ?? payload?.input ?? {};
  const file = input.file_path;
  if (!TOOLS.has(tool) || typeof file !== "string" || basename(file) !== "package.json") return null;
  const root = payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const path = isAbsolute(file) ? file : resolve(root, file);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const afterText = applyToolEdit(tool, input, current);
  if (afterText === null) return null;
  const after = parseJson(afterText);
  const before = current === "" ? {} : parseJson(current);
  if (after === null || before === null) return null;
  return { root, before, after };
}

export function evaluate(payload) {
  const e = parseEdit(payload);
  if (!e) return null;
  const { valid, problems } = loadExceptions(e.root);
  const offenders = offendingDeps(e.before, e.after, valid);
  return offenders.length ? denialReason(offenders, problems) : null;
}

// Workspace-internal packages are not external dependencies: no ledger entry needed (D086).
const INTERNAL_SPEC = /^(workspace:|file:|link:|portal:)/i;

/** New direct dependencies a package.json edit introduces: keys added to a dependency map that no manifest of the project declares yet. */
export function addedDirectDeps(before, after) {
  return diffDeps(before, after)
    .filter((d) => d.was === null && !INTERNAL_SPEC.test(d.spec.trim()))
    .map((d) => ({ eco: "npm", name: (classifyDep(d.name, d.spec).name || d.name).toLowerCase(), dev: d.section === "devDependencies", manifest: true }));
}

export function check(ctx) {
  const reason = evaluate({ tool_name: ctx.tool, tool_input: ctx.input, cwd: ctx.cwd });
  if (reason) return { deny: reason };
  // D086 necessity: a dependency key added to the manifest needs a deps-ledger.json entry (control "necessity", warn/enforce per D082)
  const e = parseEdit({ tool_name: ctx.tool, tool_input: ctx.input, cwd: ctx.cwd });
  if (!e) return undefined;
  const adds = addedDirectDeps(e.before, e.after);
  if (adds.length === 0) return undefined;
  const { message, missing } = checkNecessity(adds, ctx.config().root || e.root);
  if (!message) return undefined;
  return applyMode(ctx, "necessity", { deny: message }, { rule: "ledger", subject: missing.join(",") });
}
