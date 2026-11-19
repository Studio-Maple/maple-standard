#!/usr/bin/env node
/**
 * maple-secret.mjs - the ONLY credential retrieval path for agents (D085).
 *
 *   run --env NAME=<Target> [--env ...] [--file NAME=<Target>] -- <command> [args...]
 *       Reads each target (MAPLE_CRED_<TARGET> env first, then Credential Manager, via
 *       predeploy/credentials.mjs) and puts it ONLY in the child's env (or, for --file, in a fresh
 *       0600 UTF-8 no-BOM temp file whose path is in env NAME; deleted afterwards, also on SIGINT).
 *       The child's stdout/stderr go through an exact-value redactor (redact.mjs). Exit code passes
 *       through. A missing target exits 2 and names the TARGET only.
 *   exists <Target>   prints true|false
 *   list              prints stored target NAMES (cmdkey /list); nothing on non-Windows
 *
 * The value never reaches argv, a log, or an error message of this process.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { credentialExists, getCredential } from "../predeploy/credentials.mjs";
import { StreamRedactor } from "./redact.mjs";
import { spawnChild } from "./spawn-util.mjs";

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USAGE = "usage: maple-secret run --env NAME=<Target> [--file NAME=<Target>] -- <command> [args...] | exists <Target> | list";

const fail = (code, msg) => { process.stderr.write(`maple-secret: ${msg}\n`); return code; };

function parseRun(argv) {
  const sep = argv.indexOf("--");
  if (sep < 0 || sep === argv.length - 1) return { error: "missing `-- <command>`" };
  const opts = argv.slice(0, sep);
  const cmd = argv.slice(sep + 1);
  const specs = [];
  for (let i = 0; i < opts.length; i += 2) {
    const kind = opts[i];
    const spec = opts[i + 1] ?? "";
    const eq = spec.indexOf("=");
    if ((kind !== "--env" && kind !== "--file") || eq < 1 || eq === spec.length - 1) return { error: `bad option near "${kind}"` };
    const name = spec.slice(0, eq);
    if (!NAME_RE.test(name)) return { error: `invalid variable name "${name}"` };
    specs.push({ kind: kind.slice(2), name, target: spec.slice(eq + 1) });
  }
  if (!specs.length) return { error: "no --env / --file given" };
  return { specs, cmd };
}

function pipeRedacted(stream, sink, entries) {
  const red = new StreamRedactor(entries);
  const dec = new StringDecoder("utf8");
  return new Promise((resolve) => {
    stream.on("data", (b) => { const o = red.push(dec.write(b)); if (o) sink.write(o); });
    stream.on("end", () => { const o = red.push(dec.end()) + red.end(); if (o) sink.write(o); resolve(); });
    stream.on("error", resolve);
  });
}

async function run(argv) {
  const parsed = parseRun(argv);
  if (parsed.error) return fail(64, `${parsed.error}. ${USAGE}`);
  const secrets = [];
  for (const s of parsed.specs) {
    const value = getCredential(s.target);
    if (!value) return fail(2, `credential target "${s.target}" not found (store it with the owner-only store-secret.ps1)`);
    secrets.push({ ...s, value });
  }
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("MAPLE_CRED_")) delete env[k]; // the child gets only what it asked for
  let tmpDir = null;
  const cleanup = () => { if (tmpDir) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } tmpDir = null; } };
  const handlers = [["SIGINT", () => { cleanup(); process.exit(130); }], ["SIGTERM", () => { cleanup(); process.exit(143); }]];
  for (const [sig, h] of handlers) process.on(sig, h);
  try {
    for (const s of secrets) {
      if (s.kind === "env") { env[s.name] = s.value; continue; }
      tmpDir ??= mkdtempSync(join(tmpdir(), "maple-secret-"));
      const file = join(tmpDir, `${randomBytes(8).toString("hex")}.secret`);
      writeFileSync(file, Buffer.from(s.value, "utf8"), { mode: 0o600 }); // Buffer = UTF-8, no BOM
      env[s.name] = file;
    }
    const entries = secrets.map((s) => ({ target: s.target, value: s.value }));
    const child = spawnChild(parsed.cmd[0], parsed.cmd.slice(1), env);
    const exited = new Promise((resolve) => {
      child.on("error", (e) => { process.stderr.write(`maple-secret: cannot start command (${e.code ?? "error"})\n`); resolve(127); });
      child.on("close", (code, signal) => resolve(code ?? (signal ? 143 : 1)));
    });
    await Promise.all([child.stdout && pipeRedacted(child.stdout, process.stdout, entries), child.stderr && pipeRedacted(child.stderr, process.stderr, entries)]);
    return await exited;
  } finally {
    cleanup();
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}

/** Target names from `cmdkey /list` (Windows). Never values. */
export function listTargets() {
  if (process.platform !== "win32") return [];
  const r = spawnSync("cmdkey", ["/list"], { encoding: "utf8", timeout: 15000, windowsHide: true });
  if (r.status !== 0) return [];
  const names = new Set();
  for (const line of String(r.stdout).split(/\r?\n/)) {
    const m = /^\s*Target:\s*(.+?)\s*$/i.exec(line);
    if (m) names.add(m[1].replace(/^(?:LegacyGeneric|Domain|WindowsLive):target=/i, ""));
  }
  return [...names];
}

export async function main(argv) {
  const [sub, ...rest] = argv;
  if (sub === "run") return run(rest);
  if (sub === "exists" && rest.length === 1) { process.stdout.write(`${credentialExists(rest[0])}\n`); return 0; }
  if (sub === "list" && rest.length === 0) { const t = listTargets(); if (t.length) process.stdout.write(`${t.join("\n")}\n`); return 0; }
  return fail(64, USAGE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, () => { process.exitCode = fail(1, "internal error"); });
}
