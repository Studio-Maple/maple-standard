/** spawn-util.mjs - resolve and spawn a child on Windows without a shell unless a .cmd/.bat shim forces one. */
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join } from "node:path";

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/** Resolve a bare command against PATH/PATHEXT on win32. Returns the input unchanged elsewhere / when not found. */
export function resolveCommand(cmd, env) {
  if (process.platform !== "win32") return cmd;
  const exts = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = /[\\/]/.test(cmd) || isAbsolute(cmd) ? [""] : (env.PATH || env.Path || "").split(delimiter).filter(Boolean);
  for (const d of dirs) {
    const base = d ? join(d, cmd) : cmd;
    if (extname(base) && isFile(base)) return base;
    for (const e of exts) if (existsSync(base + e) && isFile(base + e)) return base + e;
  }
  return cmd;
}

const cmdQuote = (a) => `"${String(a).replace(/"/g, '""')}"`;

/** Spawn with piped stdout/stderr. .cmd/.bat shims go through cmd.exe with quoted args (Node refuses them otherwise). */
export function spawnChild(command, args, env) {
  const resolved = resolveCommand(command, env);
  const opts = { env, stdio: ["inherit", "pipe", "pipe"], windowsHide: true };
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved)) {
    return spawn(cmdQuote(resolved), args.map(cmdQuote), { ...opts, shell: true });
  }
  return spawn(resolved, args, opts);
}
