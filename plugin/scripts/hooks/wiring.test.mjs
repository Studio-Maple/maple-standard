#!/usr/bin/env node
// check-hook-wiring.mjs contract: duplicates of plugin/removed hooks fail, a project's own hook and the
// SessionStart echo pass. Plain node, exits non-zero on failure.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginHookNames } from "./check-hook-wiring.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-hook-wiring.mjs");
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };

function project(settings, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "wiring-"));
  mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
  if (settings !== null) writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(settings));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(root, f), c);
  return root;
}
const run = (root) => spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
const reg = (command) => ({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } });
const cleanup = (root) => rmSync(root, { recursive: true, force: true });

t("the plugin's own hook names are known", () => {
  const names = pluginHookNames();
  for (const x of ["guard", "scrub-secrets", "jev-validate-subagent", "bash-guard", "deny-credential-paths", "deploy-guard", "loop-budget-guard", "dep-version-guard", "ask-gate", "eslint-fix", "parallel-session-warn"]) assert.ok(names.has(x), x);
});

t("a settings file with only the SessionStart echo passes", () => {
  const root = project({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: 'echo "Branch: $(git branch --show-current)"' }] }] } });
  const r = run(root);
  assert.equal(r.status, 0, r.stderr);
  cleanup(root);
});

t("no .claude directory at all passes", () => {
  const root = mkdtempSync(join(tmpdir(), "wiring-"));
  assert.equal(run(root).status, 0);
  cleanup(root);
});

for (const [name, command] of [
  ["a copy of a plugin hook (relative)", "node .claude/hooks/scrub-secrets.mjs"],
  ["a removed hook by basename", "node scripts/hooks/eslint-fix.js"],
  ["a removed hook via CLAUDE_PROJECT_DIR", 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/ask-gate.mjs"'],
  ["the dispatcher registered by the project", "node ../plugin/hooks/guard.mjs"],
  ["any relative .claude/hooks path", "node .claude/hooks/my-own-thing.mjs"],
  ["build-counter", "node build-counter.js"],
]) {
  t(`fails: ${name}`, () => {
    const root = project(reg(command));
    const r = run(root);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /D065/);
    cleanup(root);
  });
}

t("fails: settings.local.json is checked too", () => {
  const root = project(null);
  writeFileSync(join(root, ".claude", "settings.local.json"), JSON.stringify(reg("node x/size-warning.js")));
  assert.equal(run(root).status, 1);
  cleanup(root);
});

t("passes: a project hook with its own name outside .claude/hooks", () => {
  const root = project(reg("node scripts/my-custom-hook.mjs"));
  assert.equal(run(root).status, 0);
  cleanup(root);
});

t("fails: a stale copy left in .claude/hooks", () => {
  const root = project({ hooks: {} }, { ".claude/hooks/decision-reminder.js": "//" });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stale copy/);
  cleanup(root);
});

t("fails: unparseable settings cannot be verified", () => {
  const root = project(null, { ".claude/settings.json": "{ nope" });
  assert.equal(run(root).status, 1);
  cleanup(root);
});

console.log(`\n${n} wiring checks passed`);
