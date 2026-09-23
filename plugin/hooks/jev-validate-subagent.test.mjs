#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { firstUserMessageText } from "./jev-validate-subagent.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "jev-validate-subagent.mjs");

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

function runHook(payload) {
  return spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: "utf8", timeout: 15_000 });
}

// --- firstUserMessageText() extraction ---
const sandbox = mkdtempSync(join(tmpdir(), "jev-hook-"));
try {
  const transcript = join(sandbox, "transcript.jsonl");
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "Refactor src/foo.ts to drop the unused export." } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it." }] } }),
    ].join("\n") + "\n",
  );
  check("extracts a plain-string user message", firstUserMessageText(transcript) === "Refactor src/foo.ts to drop the unused export.");

  const transcriptBlocks = join(sandbox, "transcript-blocks.jsonl");
  writeFileSync(
    transcriptBlocks,
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Fix the failing test." }] } }) + "\n",
  );
  check("extracts a block-array user message", firstUserMessageText(transcriptBlocks) === "Fix the failing test.");

  check("returns empty string for a missing file", firstUserMessageText(join(sandbox, "nope.jsonl")) === "");

  const empty = join(sandbox, "empty.jsonl");
  writeFileSync(empty, "");
  check("returns empty string for an empty transcript", firstUserMessageText(empty) === "");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

// --- process-level fail-open / never-block-twice behavior ---
{
  const r = runHook({ stop_hook_active: true, last_assistant_message: "I did not finish.", cwd: process.cwd() });
  check("stop_hook_active=true always allows, regardless of report content", r.status === 0, `status=${r.status} stderr=${r.stderr}`);
}

{
  const r = spawnSync(process.execPath, [HOOK], { input: "{not valid json", encoding: "utf8", timeout: 15_000 });
  check("malformed stdin fails open", r.status === 0, `status=${r.status}`);
}

{
  const r = runHook({ cwd: process.cwd(), last_assistant_message: "", transcript_path: "" });
  check("empty report/task fails open without calling jev", r.status === 0, `status=${r.status}`);
}

{
  // jev.enabled:false in the project's own maple.config.json -> judgeCompletion
  // returns without ever calling the client -> fail-open -> exit 0.
  // Deliberately NOT relying on "no credential in the store" here: a dev
  // machine may have a real TypeSafe key under one of the documented
  // fallback targets (Maple-TypeSafe-APIKey / MapleLens-TypeSafe-APIKey),
  // in which case this would exercise the REAL API instead of the
  // fail-open path it's meant to test. This also exercises the full
  // stdin -> transcript read -> judge path end to end.
  const sandbox2 = mkdtempSync(join(tmpdir(), "jev-hook-e2e-"));
  const transcript = join(sandbox2, "transcript.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "Add a login form." } }) + "\n");
  writeFileSync(join(sandbox2, "maple.config.json"), JSON.stringify({ project: { name: "x", slug: "x" }, jev: { enabled: false } }));
  try {
    const r = runHook({ cwd: sandbox2, transcript_path: transcript, last_assistant_message: "Added it, tests pass." });
    check("end-to-end run with jev.enabled=false fails open", r.status === 0, `status=${r.status} stderr=${r.stderr}`);
  } finally {
    rmSync(sandbox2, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`${failed} check(s) FAILED`);
  process.exit(1);
}
console.log("All jev-validate-subagent.mjs checks passed.");
