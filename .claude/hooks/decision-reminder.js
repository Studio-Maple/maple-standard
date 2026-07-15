#!/usr/bin/env node
/**
 * decision-reminder.js — Stop hook (the DECISION-INTEGRITY layer)
 *
 * The biggest failure mode of AI-assisted work: a decision made *in chat*
 * never lands cleanly — it gets re-litigated, contradicted across docs, or
 * lost. A hook can't *detect* a decision mechanically (decisions are prose,
 * not tool calls), so this is a NUDGE: if the turn shows strong decision
 * signals but `docs/decisions.md` wasn't touched, remind to log it.
 *
 * The capture itself is done by the agent per CLAUDE.md's Decision
 * integrity section. This hook just makes forgetting loud. Non-blocking
 * (exit 0). Watches this template's flat docs/ layout (docs/decisions.md).
 *
 * docs: docs/decisions.md
 */
const { execSync } = require("child_process");
const { readFileSync } = require("fs");

function read(stream) {
  try {
    return readFileSync(stream, "utf8");
  } catch {
    return "";
  }
}

try {
  const input = read(0); // stdin: Claude Code Stop-hook payload (JSON)
  let transcriptPath = "";
  try {
    transcriptPath = JSON.parse(input).transcript_path || "";
  } catch {
    /* no payload — fall through */
  }

  const ROOT = require("path").join(__dirname, "..", "..");

  let decisionsTouched = false;
  try {
    const st = execSync("git status --porcelain docs/decisions.md", {
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
      `DECISION-INTEGRITY: ${why}, but docs/decisions.md wasn't updated.\n` +
        `  If a decision was made, append a D### block (next id: node scripts/next-task-id.mjs --decision),\n` +
        `  then thread it into the affected doc/#T. See CLAUDE.md "Decision integrity".`
    );
  }
} catch {
  // Never block Stop on a reminder.
}
process.exit(0);
