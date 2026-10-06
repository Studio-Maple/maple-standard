#!/usr/bin/env node
// Runs scripts/ci-local.sh under a REAL bash (D066: one runner). `bash` on a Windows PATH can resolve to WSL's
// System32\bash.exe, which sees a different filesystem and fails in confusing ways; here, on Windows, Git Bash
// is found explicitly and WSL is never used. Usage: node scripts/run-gate.mjs <fast|gate|heavy> [args...]
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function gitBash() {
  if (process.platform !== "win32") return "bash";
  const exec = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  const candidates = [];
  if (exec.status === 0) candidates.push(join(exec.stdout.trim(), "..", "..", "..", "bin", "bash.exe"), join(exec.stdout.trim(), "..", "..", "bin", "bash.exe"));
  candidates.push("C:\Program Files\Git\bin\bash.exe", "C:\Program Files (x86)\Git\bin\bash.exe");
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    console.error("run-gate: Git Bash not found (looked next to `git --exec-path` and in C:\Program Files\Git). Install Git for Windows; WSL bash is deliberately not used.");
    process.exit(2);
  }
  return found;
}

const script = join(dirname(fileURLToPath(import.meta.url)), "ci-local.sh");
const r = spawnSync(gitBash(), [script, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
