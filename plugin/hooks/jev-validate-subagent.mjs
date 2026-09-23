#!/usr/bin/env node
// SubagentStop hook — validates a sub-agent's work before the main session
// consumes it (plugin/scripts/jev/validate.mjs does the actual judging;
// this file is the thin stdin/transcript/exit-code adapter, same split as
// pi-run.mjs vs the jev-model-routing skill script).
//
// Input schema (confirmed against https://code.claude.com/docs/en/hooks.md,
// 2026-09-23): session_id, prompt_id, transcript_path, cwd, scratchpad_dir,
// permission_mode, effort, hook_event_name, agent_id, agent_type,
// stop_hook_active, last_assistant_message.
//
// Block mechanism (same doc, "Exit code 2 behavior per event" table):
//   SubagentStop, exit 2 -> "Prevents the subagent from stopping, continues
//   the subagent call" — stderr is fed back to the subagent as the reason
//   it must keep going. Same convention plugin/hooks/ask-gate.mjs already
//   uses for PreToolUse. exit 0 -> allow.
//
// stop_hook_active: true means this is a RE-INVOCATION after a previous
// block already told the subagent to continue — never block twice off the
// same stop, or a wrong verdict traps the subagent in a loop. This hook
// unconditionally allows when stop_hook_active is true.
//
// Fail-open everywhere: no key, timeout (~3s, see plugin/scripts/jev/
// config.mjs's default timeoutMs), malformed reply, unreadable transcript
// -> allow. A broken validator must never be the reason a subagent gets
// stuck.

import { readFileSync } from "node:fs";
import { judgeCompletion } from "../scripts/jev/validate.mjs";

// process.exitCode + a natural return (not process.exit()) — a forced exit
// while a fetch()'s AbortSignal.timeout() handle is still winding down has
// been observed to crash Node on Windows (libuv UV_HANDLE_CLOSING
// assertion in src/win/async.c) when jev.mjs's evaluate() actually reaches
// the network. Setting exitCode and letting the event loop drain avoids it.
const allow = () => {
  process.exitCode = 0;
};
const block = (reason) => {
  process.stderr.write(`${reason}\n`);
  process.exitCode = 2;
};

/**
 * Best-effort extraction of the FIRST user/human message in a Claude Code
 * transcript JSONL — the subagent's own original task prompt. Tolerant of
 * the handful of shapes a transcript line can take; returns "" rather than
 * throwing when the format doesn't match (fail-open caller treats that as
 * "no task text to judge" and allows).
 * @param {string} transcriptPath
 */
export function firstUserMessageText(transcriptPath) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return "";
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const role = obj?.message?.role ?? obj?.role ?? obj?.type;
    if (role !== "user" && role !== "human") continue;
    const content = obj?.message?.content ?? obj?.content;
    const text = extractText(content);
    if (text) return text;
  }
  return "";
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === "text" || typeof b.text === "string"))
      .map((b) => b.text)
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

async function main(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return allow();
  }

  // Never block twice off the same stop — see header comment.
  if (payload?.stop_hook_active) return allow();

  const root = payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const report = payload?.last_assistant_message ?? "";
  const task = payload?.transcript_path ? firstUserMessageText(payload.transcript_path) : "";

  if (!task || !report) return allow(); // nothing to judge against — fail open

  const verdict = await judgeCompletion({ root, task, report, kind: "subagent" });
  if (verdict.block) return block(`JEV-VALIDATE: ${verdict.reason}`);
  return allow();
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => {
  buf += c;
});
process.stdin.on("end", () => {
  // fail-open: a hook bug must never trap the subagent
  main(buf).catch(() => {
    process.exitCode = 0;
  });
});
