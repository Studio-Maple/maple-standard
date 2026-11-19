// Shared warn/enforce switch for the security guardrail controls (D082, docs/security-guardrails.md).
//
// maple.config.json:
//   "security": {
//     "mode": "warn" | "enforce",          // default "warn"
//     "enforceAfter": "YYYY-MM-DD",        // from this date on, "warn" acts as "enforce" (mechanism, not memory)
//     "controls": { "<name>": "off" | "warn" | "enforce" | { "mode": ..., ...options } }
//   }
// No security block = every configurable control warns. ALWAYS_ENFORCE controls ignore the config: a warn on
// a PreToolUse hook lets the call run, and for these the secret would then already be in the model's context.
//
// Warn mode turns a guard's deny into a warn and appends one line to <git-common-dir>/maple/security-log.jsonl
// (time, control, rule, a short subject; never values), so the flip to enforce is decided on data.
import { appendFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

export const ALWAYS_ENFORCE = new Set(["credentialStore", "secretShell", "mcpSurface"]);
export const CONTROLS = ["packageAdd", "necessity", "secretWrite", "localhost", "gitHooks", "continuous", ...ALWAYS_ENFORCE];

function today(now) {
  return (now ? new Date(now) : new Date()).toISOString().slice(0, 10);
}

/** @returns {"off"|"warn"|"enforce"} */
export function controlMode(cfg, control, now) {
  if (ALWAYS_ENFORCE.has(control)) return "enforce";
  const sec = cfg && typeof cfg === "object" ? cfg.security : undefined;
  if (!sec || typeof sec !== "object") return "warn";
  const c = sec.controls?.[control];
  const own = typeof c === "string" ? c : c && typeof c === "object" ? c.mode : undefined;
  if (own === "off") return "off";
  let mode = own === "enforce" || own === "warn" ? own : sec.mode === "enforce" ? "enforce" : "warn";
  if (mode === "warn" && own !== "warn" && typeof sec.enforceAfter === "string" && today(now) >= sec.enforceAfter) mode = "enforce";
  return mode;
}

/** The control's options object (empty when the control is a bare mode string or absent). */
export function controlOptions(cfg, control) {
  const c = cfg?.security?.controls?.[control];
  return c && typeof c === "object" ? c : {};
}

function logFile(root) {
  try {
    const r = spawnSync("git", ["-C", root, "rev-parse", "--git-common-dir"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    if (r.status !== 0) return null;
    const dir = r.stdout.trim();
    return join(isAbsolute(dir) ? dir : resolve(root, dir), "maple", "security-log.jsonl");
  } catch {
    return null;
  }
}

/** Append one warn-mode hit. Never throws; `subject` must never carry a secret value. */
export function logWarn(root, control, rule, subject) {
  if (!root) return;
  const file = logFile(root);
  if (!file) return;
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), control, rule, subject: String(subject ?? "").slice(0, 200) }) + "\n");
  } catch { /* logging must never break a tool call */ }
}

/**
 * Apply a control's mode to a guard result. `result` is { deny } | { warn } | undefined.
 * off -> undefined; warn -> a deny becomes a warn (logged); enforce -> unchanged.
 */
export function applyMode(ctx, control, result, { rule = control, subject = "" } = {}) {
  if (!result) return undefined;
  const { root, cfg } = ctx.config();
  const mode = controlMode(cfg, control);
  if (mode === "off") return undefined;
  if (mode === "enforce" || !result.deny) return result;
  logWarn(root || ctx.cwd, control, rule, subject);
  return { warn: `[security warn mode — will block once security.enforceAfter passes] ${result.deny}` };
}
