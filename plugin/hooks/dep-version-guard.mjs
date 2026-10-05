#!/usr/bin/env node
// PreToolUse hook for Write|Edit|MultiEdit — D064: dependency versions are never hand-written.
// Part of the maple-standard plugin (plugin/hooks/hooks.json).
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
//
// Exit 0 + deny JSON on stdout = deny (same shape predeploy-guard.mjs uses). Hook errors never block.

import { existsSync, readFileSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { findException, loadExceptions } from "../scripts/deps/exceptions.mjs";
import { applyToolEdit, classifyDep, diffDeps } from "../scripts/deps/pkgjson.mjs";
import { rangeFloor } from "../scripts/deps/semver-lite.mjs";

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

export function evaluate(payload) {
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
  const { valid, problems } = loadExceptions(root);
  const offenders = offendingDeps(before, after, valid);
  return offenders.length ? denialReason(offenders, problems) : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    let reason = null;
    try {
      reason = evaluate(JSON.parse(raw));
    } catch {
      process.exit(0); // never let a hook error break tool routing
    }
    if (reason) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
    }
    process.exit(0);
  });
}
