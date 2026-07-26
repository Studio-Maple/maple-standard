#!/usr/bin/env node
/**
 * decision-reminder.js — Stop hook (the DECISION-INTEGRITY layer)
 * Part of the maple-standard plugin (plugin/hooks/hooks.json).
 *
 * The biggest failure mode of AI-assisted work: a decision made *in chat*
 * never lands cleanly — it gets re-litigated, contradicted across docs, or
 * lost. A hook can't *detect* a decision mechanically (decisions are prose,
 * not tool calls), so this is a NUDGE: if the turn shows strong decision
 * signals but the decisions doc wasn't touched, remind to log it.
 *
 * The capture itself is done by the agent. This hook just makes forgetting
 * loud. Non-blocking (exit 0).
 *
 * maple.config.json keys (all optional) — CANONICAL docs.* key per
 * docs/standard-architecture.md (docs/decisions.md D002-D011, reconciled
 * docs/tasks.md #T11/#T12 — this hook used to read its own invented
 * `docs.decisionsFile` / `docs.idAllocatorScript` keys; retired, one key
 * set now). This file is CommonJS (plugin/README.md's plugin.json has no
 * "type": "module", so .js here is CJS) while the canonical resolver
 * (plugin/scripts/docs/lib/config.mjs) is ESM — rather than an async
 * dynamic import() to bridge module systems, this MIRRORS that module's
 * DOCS_DEFAULTS + resolution logic inline (same defaults, same lookup
 * order), per docs/tasks.md #T12's explicit "use config.mjs or mirror its
 * logic" allowance:
 *   docs.decisions   default "docs/decisions.md"
 *
 * The next-task-id allocator is always the plugin's own bundled copy now
 * (plugin/scripts/docs/next-task-id.mjs, #T13) — no more
 * `docs.idAllocatorScript` config key, it's just referenced directly below.
 *
 * PROJECT ROOT: the hook payload's own `cwd` field (falling back to
 * $CLAUDE_PROJECT_DIR, then process.cwd()) — not __dirname, which resolves
 * inside the plugin's install directory, not the adopting project.
 */
const { execSync } = require("child_process");
const { readFileSync } = require("fs");
const { join } = require("path");

function read(stream) {
  try {
    return readFileSync(stream, "utf8");
  } catch {
    return "";
  }
}

function loadMapleConfig(root) {
  try {
    return JSON.parse(readFileSync(join(root, "maple.config.json"), "utf8"));
  } catch {
    return {};
  }
}

try {
  const input = read(0); // stdin: Claude Code Stop-hook payload (JSON)
  let payload = {};
  try {
    payload = JSON.parse(input);
  } catch {
    /* no payload — fall through */
  }
  const transcriptPath = payload.transcript_path || "";
  const ROOT = payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const cfg = loadMapleConfig(ROOT);
  const decisionsFile = cfg?.docs?.decisions || "docs/decisions.md";
  // The plugin's own bundled allocator (#T13) — no config key anymore.
  const idAllocatorScript = '"$CLAUDE_PLUGIN_ROOT/scripts/docs/next-task-id.mjs"';

  let decisionsTouched = false;
  try {
    const st = execSync(`git status --porcelain -- "${decisionsFile}"`, {
      cwd: ROOT,
      encoding: "utf8",
    });
    decisionsTouched = st.trim().length > 0;
  } catch {
    /* ignore */
  }
  if (decisionsTouched) process.exit(0);

  let signal = false;
  let why = "";
  if (transcriptPath) {
    const tail = read(transcriptPath).slice(-20000); // last chunk only
    if (/AskUserQuestion/.test(tail)) {
      signal = true;
      why = "an AskUserQuestion was answered";
    } else if (
      /\b(we'?ll (?:use|go with|keep|drop)|let'?s go with|going with|i (?:decided|chose)|decided to|use [^.]{1,40} instead|that's the plan|final call|supersed|make it canonical|the canonical)\b/i.test(
        tail
      )
    ) {
      signal = true;
      why = "the turn contains decision language";
    }
  }

  if (signal) {
    console.error(
      `DECISION-INTEGRITY: ${why}, but ${decisionsFile} wasn't updated.\n` +
        `  If a decision was made, append a D### block (next id: node ${idAllocatorScript} --decision),\n` +
        `  then thread it into the affected doc/task. See CLAUDE.md "Decision integrity" (or the project's equivalent).`
    );
  }
} catch {
  // Never block Stop on a reminder.
}
process.exit(0);
