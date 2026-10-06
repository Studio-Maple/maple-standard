#!/usr/bin/env node
// The ONE PreToolUse hook of the maple-standard plugin (D065). Claude Code spawns it once per matching
// tool call; it loads only the guard modules relevant to that tool (lazy dynamic import), runs them
// in-process, and the first deny wins. No guard spawns a child process unless its own trigger matched
// (git is only asked about for `git worktree add` / `git push` / an active loop cycle).
//
//   Bash | PowerShell   loop-budget, hook-bypass, credentials, worktree placement, deploy gate, shell guards
//                       (cwd / push / clean / dependency-install freshness)
//   Read | Grep | Glob  loop-budget, credential paths
//   Write | Edit | MultiEdit   loop-budget, dependency versions (D064), deploy-gate state / ask files
//   mcp__*              loop-budget, mutating Supabase MCP tools
//
// Output contract: deny = reason on stderr + exit 2; ask = permissionDecision JSON on stdout (exit 0);
// warnings ride along as additionalContext. Malformed input and guard bugs fail OPEN, except the
// deploy guard, which fails CLOSED for deploy-shaped commands (internal error or its own deadline).
import { readFileSync, writeSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseShell } from "./guards/shell.mjs";
import { projectConfig } from "./guards/project.mjs";

const DEADLINE_MS = 12_000; // below the hook's own timeout (hooks.json), so we answer instead of being killed

const SHELL_GUARDS = ["loop-budget-guard", "hook-bypass", "deny-credential-paths", "worktree-guard", "deploy-guard", "bash-guard"];

/** Which guard modules a tool call needs, in run order. */
export function planFor(tool, hasCommand) {
  if (tool === "Bash" || tool === "PowerShell") return hasCommand ? SHELL_GUARDS : [];
  if (tool === "Read" || tool === "Grep" || tool === "Glob") return ["loop-budget-guard", "deny-credential-paths"];
  if (tool === "Write" || tool === "Edit" || tool === "MultiEdit") return ["loop-budget-guard", "dep-version-guard", "deploy-guard"];
  if (typeof tool === "string" && tool.startsWith("mcp__")) return ["loop-budget-guard", "mcp-guard"];
  return [];
}

export function buildContext(payload) {
  const tool = payload?.tool_name || "";
  const input = payload?.tool_input ?? payload?.input ?? {};
  const cwd = payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const shell = tool === "PowerShell" ? "powershell" : "bash";
  const command = typeof input.command === "string" ? input.command : "";
  let segs;
  let conf;
  return {
    payload, tool, input, cwd, shell, command,
    segments: () => (segs ??= parseShell(command, shell)),
    config: () => (conf ??= projectConfig(cwd)),
  };
}

/** Run the guards for one call. @returns {{ deny?: string, ask?: string, warns: string[] }} */
export async function evaluate(payload) {
  const ctx = buildContext(payload);
  const out = { warns: [] };
  let deployMod = null;
  let timer;
  const deadline = new Promise((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline("deadline"), DEADLINE_MS);
    timer.unref?.();
  });
  const run = async () => {
    for (const name of planFor(ctx.tool, Boolean(ctx.command))) {
      let mod;
      try {
        mod = await import(`./guards/${name}.mjs`);
        if (name === "deploy-guard") deployMod = mod;
        const r = await mod.check(ctx);
        if (!r) continue;
        if (r.deny) { out.deny = r.deny; return; }
        if (r.ask && !out.ask) out.ask = r.ask;
        if (r.warn) out.warns.push(r.warn);
      } catch (err) {
        const why = `internal error in ${name} (${err instanceof Error ? err.message : err})`;
        const closed = name === "deploy-guard" ? mod?.failClosed?.(ctx, why) : undefined;
        if (closed?.deny) { out.deny = closed.deny; return; }
        out.warns.push(`${name}: ${why}; allowed`);
      }
    }
  };
  const winner = await Promise.race([run().then(() => "done"), deadline]);
  clearTimeout(timer);
  if (winner === "deadline" && !out.deny) {
    deployMod ??= await import("./guards/deploy-guard.mjs");
    const closed = deployMod.failClosed(ctx, "the guard hit its internal deadline");
    if (closed?.deny) out.deny = closed.deny;
    else out.warns.push("guard: internal deadline reached; allowed");
  }
  return out;
}

function emit(fd, text) {
  try { writeSync(fd, text); } catch { /* closed pipe: nothing useful left to do */ }
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0; // unparseable input must never break tool routing
  }
  const res = await evaluate(payload);
  if (res.deny) {
    emit(2, `${res.deny}\n`);
    return 2;
  }
  if (res.warns.length) emit(2, `${res.warns.join("\n")}\n`);
  const hso = { hookEventName: "PreToolUse" };
  if (res.ask) { hso.permissionDecision = "ask"; hso.permissionDecisionReason = res.ask; }
  if (res.warns.length) hso.additionalContext = res.warns.join("\n");
  if (res.ask || res.warns.length) emit(1, JSON.stringify({ hookSpecificOutput: hso }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), () => process.exit(0));
}
