#!/usr/bin/env node
// PreToolUse hook (Bash | PowerShell | Write | Edit | MultiEdit) — ENFORCES the
// pre-deploy gate (D060). Part of the maple-standard plugin.
//
//  1. Deploy commands (maple.config.json predeploy.deployGuard.patterns) are
//     BLOCKED (exit 2) unless a valid predeploy stamp exists for HEAD:
//     stamp for this exact sha, not expired, config + allowlist hashes
//     unchanged, tracked tree clean, no unscanned live-deploy debt. An allowed
//     deploy is appended to the deploy ledger (which is what later blocks the
//     NEXT deploy until a clean live scan covers it).
//  2. The gate's own state (stamps, ledger, live-scan records, the emergency
//     override) cannot be written by tool commands — a stamp is only ever
//     produced by the gate runner.
//  3. Editing the allowlist or maple.config.json forces an `ask` (owner
//     approval): exceptions and gate changes are never silent.
//
// There is NO bypass flag. The only override is the owner's interactive
// emergency override (scripts/predeploy/emergency.mjs — needs a TTY and a typed
// confirmation phrase; default off; logged). Fails open only on malformed hook
// input (hook errors must not break tool routing); a missing/invalid stamp
// fails CLOSED.
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PD = join(HERE, "..", "scripts", "predeploy");

const READ_ONLY_LEADER = /^(echo|printf|git|grep|egrep|rg|cat|sed|awk|head|tail|ls|dir|type|less|more|wc|diff|code|vim|nano|get-content|select-string|write-output|write-host|gc|sls|findstr|man|help|which|where|test|\[)\b/i;

/** Split a shell/PowerShell line into command segments and drop wrappers/env prefixes. */
export function segments(command) {
  return command
    .split(/&&|\|\||;|\||\r?\n/)
    .map((s) => s.trim().replace(/^(?:&\s+|call\s+|[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/i, ""))
    .filter(Boolean);
}

/** @returns the first pattern that matches an EXECUTING segment, else null. */
export function matchDeploy(command, patterns) {
  for (const seg of segments(command)) {
    if (READ_ONLY_LEADER.test(seg)) continue;
    for (const p of patterns) {
      let re;
      try { re = new RegExp(p.regex, "i"); } catch { continue; }
      if (re.test(seg)) return p;
    }
  }
  return null;
}

const STATE_RE = /maple[\\/]predeploy[\\/]?(stamps|emergency|live-scans|deploys|reports)?|emergency\.json|deploys\.jsonl/i;

const PURE_READ = /^(cat|ls|dir|type|head|tail|grep|egrep|rg|get-content|select-string|gc|sls|wc|findstr|git\s+(log|show|status|diff))\b/i;

export function touchesGateState(command) {
  // A reader is exempt only when it neither redirects (`>`), edits in place, nor pipes into a writer.
  return segments(command).some((seg) => STATE_RE.test(seg) && !(PURE_READ.test(seg) && !/>|\bsed\s+-i\b/.test(seg)));
}

function emit(decision, reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } }));
}

async function run(payload) {
  const tool = payload?.tool_name || "";
  const input = payload?.tool_input ?? payload?.input ?? {};
  const lib = await import(pathToFileURL(join(PD, "lib.mjs")).href);
  const start = payload?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const root = lib.findProjectRoot(start);
  if (!root) return 0;
  const cfg = lib.loadMapleConfig(root);
  if (cfg === null) {
    // maple.config.json exists (findProjectRoot) but does not parse: fail CLOSED on deploy-shaped commands.
    const c = typeof input.command === "string" ? input.command : "";
    if (/(^|[\s/\\])(deploy[\w.-]*|terraform\s+apply|db\s+push|functions\s+deploy|wrangler\s+(pages\s+)?deploy)\b/i.test(c) && !READ_ONLY_LEADER.test(c.trim())) {
      process.stderr.write("BLOCKED (predeploy-guard): maple.config.json is not valid JSON, so the deploy guard cannot read its patterns; deploy-shaped commands are refused until it parses.\n");
      return 2;
    }
    return 0;
  }
  const { normalize } = await import(pathToFileURL(join(PD, "config.mjs")).href);
  const pd = normalize(cfg);
  if (!pd || pd.enabled === false) return 0;

  if (/^(Write|Edit|MultiEdit)$/.test(tool)) {
    const file = input.file_path || input.path || "";
    if (!file) return 0;
    const abs = resolve(start, file);
    if (STATE_RE.test(abs) && abs.includes(`maple${sep}predeploy`)) {
      process.stderr.write("BLOCKED (predeploy-guard): the gate's state (stamps, deploy ledger, live-scan records, emergency override) is written only by the gate runner.\n");
      return 2;
    }
    const rel = relative(root, abs).split(sep).join("/");
    if (rel === String(pd.allowlist).replace(/\\/g, "/") || rel === "maple.config.json") {
      emit("ask", `Owner approval needed: ${rel} defines the pre-deploy gate's exceptions/configuration. Allowlist entries need a reason, an owner and an expiry — confirm this change is reviewed.`);
    }
    return 0;
  }

  if (!/^(Bash|PowerShell)$/.test(tool)) return 0;
  const command = typeof input.command === "string" ? input.command : "";
  if (!command) return 0;

  if (touchesGateState(command)) {
    process.stderr.write("BLOCKED (predeploy-guard): this command touches the gate's state directory (maple/predeploy). Stamps, the deploy ledger and the emergency override are written only by the gate runner / the owner's interactive override.\n");
    return 2;
  }

  const hit = matchDeploy(command, pd.deployGuard.patterns || []);
  if (!hit) return 0;

  const { verifyStamp, appendLedger } = await import(pathToFileURL(join(PD, "state.mjs")).href);
  const v = verifyStamp(root);
  if (!v.ok) {
    process.stderr.write(
      `BLOCKED (predeploy-guard): deploy command "${hit.id}"${hit.description ? " (" + hit.description + ")" : ""} refused — ${v.reason}.\n` +
      `  Run /predeploy-gate (node "<plugin>/scripts/predeploy/run.mjs") on a clean tree at the commit you intend to deploy; it must finish with STAMP ISSUED.\n` +
      `  There is no bypass flag. The owner's emergency override is documented in docs/predeploy-gate.md (default off).\n`,
    );
    return 2;
  }
  try {
    appendLedger(root, { sha: v.sha, patternId: hit.id, command: command.slice(0, 200).replace(/(token|secret|password|key)[=:\s]+\S+/gi, "$1=<redacted>"), emergency: Boolean(v.emergency) });
  } catch { /* ledger failure must not wedge a legitimately stamped deploy */ }
  if (v.emergency) process.stderr.write(`WARNING (predeploy-guard): EMERGENCY OVERRIDE in effect — ${v.reason}\n`);
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { raw += c; });
  process.stdin.on("end", async () => {
    let payload;
    try { payload = JSON.parse(raw); } catch { process.exit(0); }
    try { process.exit(await run(payload)); } catch (e) {
      // Unexpected internal error: a deploy-shaped command must not slip through on a crash.
      const input = payload?.tool_input ?? {};
      if (typeof input.command === "string" && /deploy|terraform\s+apply|db\s+push|functions\s+deploy/i.test(input.command)) {
        process.stderr.write(`BLOCKED (predeploy-guard): internal error while checking a deploy-shaped command (${e.message}). Failing closed.\n`);
        process.exit(2);
      }
      process.exit(0);
    }
  });
}
