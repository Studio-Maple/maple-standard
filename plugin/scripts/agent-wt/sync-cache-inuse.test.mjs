#!/usr/bin/env node
/**
 * sync-cache-inuse.test.mjs - D069: sync-plugin-cache never deletes a superseded plugin version
 * that a live process may be using (the 2026-10-07 incident: 0.13.0 removed under a running
 * maple-reap). Sandbox HOME + a mini repo carrying a copy of the real script.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SYNC = join(HERE, "..", "sync-plugin-cache.mjs");
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed++;
};

const sb = mkdtempSync(join(tmpdir(), "maple-sync-"));
try {
  const repo = join(sb, "Repo");
  const pluginDir = join(repo, "plugin");
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(pluginDir, "scripts"), { recursive: true });
  copyFileSync(SYNC, join(pluginDir, "scripts", "sync-plugin-cache.mjs"));
  writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "pl", version: "2.0.0" }));
  const home = join(sb, "home");
  const plugins = join(home, ".claude", "plugins");
  const cache = join(plugins, "cache", "mk", "pl");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(plugins, "known_marketplaces.json"), JSON.stringify({ mk: { source: { source: "directory", path: repo } } }));
  writeFileSync(join(plugins, "installed_plugins.json"), JSON.stringify({ plugins: { "pl@mk": [{ version: "1.0.0" }] } }));

  const run = (extraEnv = {}) =>
    spawnSync(process.execPath, [join(pluginDir, "scripts", "sync-plugin-cache.mjs")], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv },
    });
  const dirOf = (v) => join(cache, v);
  const mkOld = (v) => {
    mkdirSync(join(dirOf(v), ".in_use"), { recursive: true });
    writeFileSync(join(dirOf(v), "x"), "x");
  };

  // A dead pid: a process that has already exited.
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const deadPid = dead.stdout.trim();

  mkOld("1.0.0"); // live pid marker (this very process)
  writeFileSync(join(dirOf("1.0.0"), ".in_use", String(process.pid)), "");
  mkOld("0.9.0"); // dead pid marker only
  writeFileSync(join(dirOf("0.9.0"), ".in_use", deadPid), "");
  mkOld("0.8.0"); // no marker at all

  // Default 24h grace: nothing superseded is deleted on the first run.
  let r = run();
  check("sync ran", r.status === 0 && existsSync(dirOf("2.0.0")), String(r.stderr).trim().slice(-200));
  check(
    "default grace keeps every superseded version",
    existsSync(dirOf("1.0.0")) && existsSync(dirOf("0.9.0")) && existsSync(dirOf("0.8.0")),
  );

  // Grace elapsed: a live pid still protects; dead pid / no marker are reclaimed.
  r = run({ MAPLE_SYNC_GRACE_HOURS: "0" });
  check("version with a LIVE in-use pid is kept past grace", existsSync(dirOf("1.0.0")));
  check("version with only a dead pid is deleted after grace", !existsSync(dirOf("0.9.0")));
  check("version with no marker is deleted after grace", !existsSync(dirOf("0.8.0")));
  check("current version is never deleted", existsSync(dirOf("2.0.0")));
  check("live in-use marker was not cleaned", existsSync(join(dirOf("1.0.0"), ".in_use", String(process.pid))));
} finally {
  rmSync(sb, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("sync-cache-inuse: all assertions passed.");
