#!/usr/bin/env node
// Every plugin script must parse. A SyntaxError in a file that only an integration test loads
// (heavy-run.mjs, 2026-10-07: a literal newline inside a string) passed the whole fast tier and
// would have crashed the next heavy run. `node --check` on every plugin .mjs/.js/.cjs, in parallel.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(mjs|cjs|js)$/.test(e.name)) files.push(p);
  }
})(PLUGIN);

const check = (f) => new Promise((done) => {
  const c = spawn(process.execPath, ["--check", f], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let err = "";
  c.stderr.on("data", (d) => { err += d; });
  c.on("close", (code) => done({ f, code, err }));
});

const LIMIT = 8;
const results = [];
for (let i = 0; i < files.length; i += LIMIT) results.push(...(await Promise.all(files.slice(i, i + LIMIT).map(check))));
const bad = results.filter((r) => r.code !== 0);
for (const b of bad) console.error(`SYNTAX ERROR ${relative(PLUGIN, b.f)}\n${b.err.split("\n").slice(0, 4).join("\n")}`);
if (bad.length) { console.error(`${bad.length} of ${files.length} plugin script(s) do not parse`); process.exit(1); }
console.log(`all ${files.length} plugin scripts parse`);
