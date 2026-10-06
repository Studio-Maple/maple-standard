/**
 * find-bash.mjs - a REAL bash, never WSL (D066). On a Windows PATH `bash` can resolve to WSL's
 * C:\Windows\System32\bash.exe, which sees another filesystem (the "PowerShell's bash is WSL" failure). On
 * Windows this looks next to `git --exec-path` (<Git>\mingw64\libexec\git-core -> <Git>\bin\bash.exe), then in the
 * default install dirs, and refuses System32. Elsewhere plain `bash`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function candidates(execPath) {
  const c = [];
  if (execPath) {
    c.push(join(execPath, "..", "..", "..", "bin", "bash.exe"), join(execPath, "..", "..", "bin", "bash.exe"));
  }
  c.push("C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe");
  return c;
}

export function findBash(platform = process.platform, exists = existsSync, gitExecPath = () => {
  const r = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}) {
  if (platform !== "win32") return "bash";
  for (const c of candidates(gitExecPath())) {
    if (/system32/i.test(c)) continue;
    if (exists(c)) return c;
  }
  throw new Error("Git Bash not found (looked next to `git --exec-path` and in C:\\Program Files\\Git). Install Git for Windows; WSL bash is deliberately not used.");
}

/** C:\a\b -> C:/a/b (Git Bash and git accept forward slashes everywhere) */
export const toPosix = (p) => String(p).replace(/\\/g, "/");
