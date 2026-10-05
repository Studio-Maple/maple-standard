#!/usr/bin/env node
// Process-level tests for dep-version-guard.mjs (PreToolUse deny JSON) and bash-guard's dep check (D064).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, "dep-version-guard.mjs");
const BASH = join(HERE, "bash-guard.mjs");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const runHook = (script, payload, raw) => spawnSync(process.execPath, [script], { input: raw ?? JSON.stringify(payload), encoding: "utf8", timeout: 20_000 });
const denied = (r) => r.stdout.includes('"permissionDecision":"deny"');

const root = mkdtempSync(join(tmpdir(), "dep-hook-"));
try {
  const pkg = JSON.stringify({ name: "x", scripts: { build: "next build" }, dependencies: { react: "19.2.7" } }, null, 2);
  const file = join(root, "package.json");
  writeFileSync(file, pkg);
  const edit = (old_string, new_string, file_path = file) => ({ tool_name: "Edit", cwd: root, tool_input: { file_path, old_string, new_string } });

  let r = runHook(GUARD, edit('"react": "19.2.7"', '"react": "19.2.7",\n    "left": "^1.0.0"'));
  check("Edit adding a dependency is denied", denied(r) && r.stdout.includes("pnpm add") && r.stdout.includes("D064"), r.stdout);

  r = runHook(GUARD, edit('"react": "19.2.7"', '"react": "^17.0.0"'));
  check("Edit changing a spec is denied", denied(r));

  r = runHook(GUARD, edit('"build": "next build"', '"build": "next build --turbo"'));
  check("scripts edit passes", r.status === 0 && r.stdout === "");

  r = runHook(GUARD, edit('"react": "19.2.7"', '"react": "workspace:*"'));
  check("workspace spec passes", r.stdout === "");

  r = runHook(GUARD, { tool_name: "MultiEdit", cwd: root, tool_input: { file_path: file, edits: [{ old_string: '"build": "next build"', new_string: '"build": "x"' }, { old_string: '"react": "19.2.7"', new_string: '"react": "^16.0.0"' }] } });
  check("MultiEdit with a dependency change is denied", denied(r));

  r = runHook(GUARD, { tool_name: "Write", cwd: root, tool_input: { file_path: join(root, "sub", "package.json"), content: JSON.stringify({ dependencies: { a: "^1.0.0" } }) } });
  check("Write of a new package.json with deps is denied", denied(r));

  r = runHook(GUARD, { tool_name: "Write", cwd: root, tool_input: { file_path: file, content: JSON.stringify({ name: "x", dependencies: {} }) } });
  check("Write that removes dependencies passes", r.stdout === "");

  r = runHook(GUARD, { tool_name: "Write", cwd: root, tool_input: { file_path: file, content: "{ not json" } });
  check("unparseable result passes", r.stdout === "");

  r = runHook(GUARD, edit("x", "y", join(root, "notes.json")));
  check("other file names are ignored", r.stdout === "");

  r = runHook(GUARD, null, "garbage");
  check("garbage stdin never blocks", r.status === 0 && r.stdout === "");

  // exception list
  writeFileSync(join(root, "maple.config.json"), JSON.stringify({ deps: { exceptions: [{ name: "react", range: "^17.0.0", decision: "D070", why: "legacy renderer needs react 17" }] } }));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "decisions.md"), "## D001 | 2026-01-01 | baseline\n");
  r = runHook(GUARD, edit('"react": "19.2.7"', '"react": "^17.0.2"'));
  check("exception citing a missing D### does not apply", denied(r) && r.stdout.includes("not in the decisions ledger"), r.stdout);
  writeFileSync(join(root, "docs", "decisions.md"), "## D070 | 2026-10-05 | react 17 pinned\n");
  r = runHook(GUARD, edit('"react": "19.2.7"', '"react": "^17.0.2"'));
  check("valid exception allows the hand-written spec", r.stdout === "", r.stdout);
  r = runHook(GUARD, edit('"react": "19.2.7"', '"react": "^16.0.0"'));
  check("exception does not cover another major", denied(r));

  // bash-guard (offline-safe: only commands that never need the registry, plus a guaranteed-unreachable one)
  const bash = (command) => runHook(BASH, { cwd: root, tool_input: { command } });
  r = bash(`cd "C:/somewhere" && pnpm add react`);
  check("bare install allowed", r.status === 0, r.stderr);
  r = bash(`cd "C:/somewhere" && pnpm add react@latest`);
  check("dist-tag install allowed", r.status === 0, r.stderr);
  r = spawnSync(process.execPath, [BASH], { input: JSON.stringify({ cwd: root, tool_input: { command: `cd "C:/somewhere" && pnpm add react@17` } }), encoding: "utf8", timeout: 20_000, env: { ...process.env, npm_config_registry: "http://127.0.0.1:9" } });
  check("unreachable registry allows with a warning", r.status === 0 && r.stderr.includes("could not verify react@17"), r.stderr);
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
