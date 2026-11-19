#!/usr/bin/env node
/**
 * precommit-secrets.mjs — gitleaks over the STAGED changes, run from .husky/pre-commit (D081, security
 * control "gitHooks"). Self-contained on purpose: projects vendor it byte-identically (scripts/), like
 * prepush-lib.sh, so their hook does not depend on the plugin being installed.
 *
 *   node scripts/precommit-secrets.mjs [repoRoot]
 *
 * Mode (maple.config.json security): off -> skip; warn -> report and exit 0; enforce -> exit 1 on a leak.
 * No security block = warn; security.enforceAfter flips warn to enforce on that date (D082).
 * A missing gitleaks binary FAILS in enforce mode (never a silent skip) and warns otherwise.
 * --redact keeps the secret out of the terminal and out of any agent's context. `gitleaks:allow` inline
 * comments are ignored; the project's .gitleaks.toml still applies (allowlists there are audited by the
 * predeploy suppression-audit, D061).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] || process.cwd());

function mode() {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(root, "maple.config.json"), "utf8")) ?? {}; } catch { /* no config: defaults */ }
  const sec = cfg.security;
  if (!sec || typeof sec !== "object") return "warn";
  const c = sec.controls?.gitHooks;
  const own = typeof c === "string" ? c : c && typeof c === "object" ? c.mode : undefined;
  if (own === "off") return "off";
  let m = own === "enforce" || own === "warn" ? own : sec.mode === "enforce" ? "enforce" : "warn";
  if (m === "warn" && own !== "warn" && typeof sec.enforceAfter === "string" && new Date().toISOString().slice(0, 10) >= sec.enforceAfter) m = "enforce";
  return m;
}

const m = mode();
if (m === "off") process.exit(0);
const tag = m === "enforce" ? "" : " [warn mode: not blocking yet]";

const probe = spawnSync("gitleaks", ["version"], { encoding: "utf8", windowsHide: true });
if (probe.error || probe.status !== 0) {
  console.error(`  gitleaks: NOT INSTALLED${tag} — install it (scoop install gitleaks / brew install gitleaks).`);
  process.exit(m === "enforce" ? 1 : 0);
}

const args = ["git", "--staged", "--redact", "--no-banner", "--ignore-gitleaks-allow", "--exit-code", "1"];
if (existsSync(join(root, ".gitleaks.toml"))) args.push("--config", join(root, ".gitleaks.toml"));
args.push(root);
const r = spawnSync("gitleaks", args, { cwd: root, encoding: "utf8", windowsHide: true });
if (r.status === 0) {
  console.log("  gitleaks (staged): OK");
  process.exit(0);
}
process.stderr.write(r.stdout || "");
process.stderr.write(r.stderr || "");
if (r.status === 1) {
  console.error(`  gitleaks (staged): SECRET FOUND in the staged changes${tag}. Remove it from the file, keep the value in the credential store / platform secret store, and rotate it if it was ever real.`);
} else {
  console.error(`  gitleaks (staged): scanner error (exit ${r.status})${tag}.`);
}
process.exit(m === "enforce" ? 1 : 0);
