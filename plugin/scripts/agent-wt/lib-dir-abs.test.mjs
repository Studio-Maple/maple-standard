#!/usr/bin/env node
// Regression (D069 follow-up): maple-lib.sh sourced by a RELATIVE path must still find its
// link tools after the caller cds elsewhere. Before the fix, ${BASH_SOURCE[0]} stayed relative,
// so maple-land's cleanup (which cds to the main root) saw "link-strip tools not found" and
// kept every landed worktree. All other candidates are disabled so only the lib's own dir counts.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const elsewhere = mkdtempSync(join(tmpdir(), "maple-libdir-"));
const toPosix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);

const script = [
  "set +e",
  `cd "${toPosix(REPO)}"`,
  "source plugin/scripts/agent-wt/maple-lib.sh >/dev/null 2>&1",
  "set +e",
  `cd "${toPosix(elsewhere)}"`,
  "MAPLE_MAIN_ROOT=/nonexistent-root",
  "unset CLAUDE_PLUGIN_ROOT",
  "HOME=/nonexistent-home",
  "_maple_resolve_link_tools; echo \" rc=$?\"",
].join("\n");

const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "bash";
const r = spawnSync(bash, ["-c", script], { encoding: "utf8", env: { ...process.env, CLAUDE_PLUGIN_ROOT: "" } });
rmSync(elsewhere, { recursive: true, force: true });
const out = (r.stdout || "").trim();
const ok = /rc=0$/.test(out) && /plugin\/scripts\/agent-wt rc=0$/.test(out.replace(/\\/g, "/"));
if (!ok) {
  console.error(`FAIL lib dir not resolved after cd (relative source): ${JSON.stringify(out)} ${r.stderr || ""}`);
  process.exit(1);
}
console.log("ok - maple-lib finds its link tools after the caller cds away (relative source path)");
