#!/usr/bin/env node
/**
 * dispatcher.test.mjs — process-level contract of plugin/hooks/guard.mjs (D065): ONE node process handles a
 * tool call, the no-op path starts no child process, deny = stderr + exit 2, ask = JSON on stdout, garbage
 * input never blocks, and hooks.json registers exactly one PreToolUse command. Plain node, non-zero on failure.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, "..", "..", "hooks", "guard.mjs");
const TRACE = join(HERE, "spawn-trace.cjs");
const tmp = mkdtempSync(join(tmpdir(), "dispatcher-"));
const traceFile = join(tmp, "spawns.log");
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };

/** One dispatcher process; returns its result and every child process it spawned. */
function call(payload, { cwd = tmp, env = {} } = {}) {
  rmSync(traceFile, { force: true });
  const r = spawnSync(process.execPath, ["--require", TRACE, GUARD], {
    input: typeof payload === "string" ? payload : JSON.stringify({ cwd, ...payload }),
    encoding: "utf8",
    env: { ...process.env, SPAWN_TRACE_FILE: traceFile, ...env },
  });
  const spawned = existsSync(traceFile) ? readFileSync(traceFile, "utf8").trim().split("\n").filter(Boolean) : [];
  return { ...r, spawned };
}
const sh = (command, extra = {}) => ({ tool_name: "Bash", tool_input: { command, ...extra } });

try {
  t("the tracer sees a spawn when one happens (so the no-op assertions mean something)", () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    spawnSync("git", ["init", "-q"], { cwd: repo });
    const r = call(sh("git worktree add ../sibling-wt"), { cwd: repo });
    assert.ok(r.spawned.some((s) => s.startsWith("spawnSync git") || s.startsWith("execFileSync git")), JSON.stringify(r.spawned));
  });

  t("no-op calls spawn NO child process (shell, read, edit, mcp)", () => {
    for (const p of [
      sh("ls"),
      sh("git status"),
      sh("git commit -m \"mention --no-verify\""),
      { tool_name: "PowerShell", tool_input: { command: "Get-ChildItem" } },
      { tool_name: "Read", tool_input: { file_path: join(tmp, "README.md") } },
      { tool_name: "Grep", tool_input: { pattern: "x", path: tmp } },
      { tool_name: "Edit", tool_input: { file_path: join(tmp, "a.ts"), old_string: "a", new_string: "b" } },
      { tool_name: "mcp__x__list_tables", tool_input: { project_id: "p" } },
    ]) {
      const r = call(p);
      assert.equal(r.status, 0, `${p.tool_name}: ${r.stderr}`);
      assert.equal(r.stdout, "");
      assert.deepEqual(r.spawned, [], `${p.tool_name} spawned ${JSON.stringify(r.spawned)}`);
    }
  });

  t("tools the plugin does not guard exit at once", () => {
    const r = call({ tool_name: "TodoWrite", tool_input: {} });
    assert.equal(r.status, 0);
    assert.deepEqual(r.spawned, []);
  });

  t("deny = reason on stderr + exit 2, no stdout", () => {
    const r = call(sh("git push --no-verify", { run_in_background: true }));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /hook-bypass/);
    assert.equal(r.stdout, "");
  });

  t("first deny wins: one reason, not a pile", () => {
    const r = call(sh("HUSKY=0 git commit --no-verify -m x && cat .env"));
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim().split("\n").filter((l) => l.startsWith("BLOCKED")).length, 1);
  });

  t("credential read from PowerShell is denied; the example file is not", () => {
    assert.equal(call({ tool_name: "PowerShell", tool_input: { command: "Get-Content .env.local" } }).status, 2);
    assert.equal(call(sh("cat .env.example")).status, 0);
  });

  t("ask = permissionDecision JSON on stdout, exit 0", () => {
    const root = join(tmp, "askproj");
    mkdirSync(root);
    writeFileSync(join(root, "maple.config.json"), JSON.stringify({ predeploy: { checks: [{ id: "a", command: "node -e 0" }] } }));
    const r = call({ tool_name: "Edit", tool_input: { file_path: join(root, "predeploy-allowlist.json"), old_string: "a", new_string: "b" } }, { cwd: root });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, "PreToolUse");
    assert.equal(out.permissionDecision, "ask");
  });

  t("warnings ride along as additionalContext (allow)", () => {
    const r = call(sh("git worktree add \"$WT\""), { cwd: tmp });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.match(out.additionalContext, /could not resolve/);
    assert.equal(out.permissionDecision, undefined);
  });

  t("unparseable stdin and empty payloads never block", () => {
    assert.equal(call("not json").status, 0);
    assert.equal(call("{}").status, 0);
    assert.equal(call(JSON.stringify({ tool_name: "Bash" })).status, 0);
  });

  t("an active loop cycle is the only thing that makes the loop guard resolve a git root", () => {
    const root = join(tmp, "loopproj");
    mkdirSync(join(root, ".loop-state"), { recursive: true });
    writeFileSync(join(root, ".loop-state", "current-cycle.json"), JSON.stringify({ startedAt: new Date().toISOString(), deadlineMs: Date.now() - 1000 }));
    const r = call(sh("ls"), { cwd: root });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /LOOP BUDGET EXCEEDED/);
    assert.ok(r.spawned.length >= 1, "a live cycle resolves its root with git");
    assert.equal(call(sh("ls"), { cwd: root }).status, 0, "one-shot: the next call is allowed");
  });

  t("hooks.json: ONE PreToolUse command (the dispatcher), scrub-secrets on PostToolUse, nothing else per-turn", () => {
    const h = JSON.parse(readFileSync(join(HERE, "..", "..", "hooks", "hooks.json"), "utf8")).hooks;
    const cmds = (ev) => (h[ev] ?? []).flatMap((e) => e.hooks.map((x) => x.command));
    assert.equal(cmds("PreToolUse").length, 1);
    assert.match(cmds("PreToolUse")[0], /hooks\/guard\.mjs/);
    assert.match(h.PreToolUse[0].matcher, /Bash\|PowerShell/);
    assert.match(h.PreToolUse[0].matcher, /mcp__/);
    assert.equal(cmds("PostToolUse").length, 1);
    assert.match(cmds("PostToolUse")[0], /scrub-secrets/);
    assert.match(h.PostToolUse[0].matcher, /PowerShell/);
    assert.equal(h.Stop, undefined);
    assert.equal(h.SessionStart, undefined);
    assert.deepEqual(Object.keys(h).sort(), ["PostToolUse", "PreToolUse", "SubagentStop"]);
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${n} dispatcher checks passed`);
