// scripts/run-gate.mjs is a consumer-copied template. It used to carry its own Git Bash candidate list in NORMAL JS
// strings, where \P and \G drop their backslash and \b is a backspace, so the fallback path never matched. It now
// imports find-bash.mjs (one implementation); these tests pin that.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { candidates, findBash } from "./find-bash.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { pluginDir } = await import(pathToFileURL(join(ROOT, "scripts", "run-gate.mjs")).href);
const gateText = readFileSync(join(ROOT, "scripts", "run-gate.mjs"), "utf8");
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

await t("run-gate.mjs imports find-bash.mjs and keeps no hard-coded Git path of its own", () => {
  assert.match(gateText, /find-bash\.mjs/);
  assert.match(gateText, /findBash/);
  const code = gateText.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/Program Files/.test(code));
});

await t("run-gate.mjs resolves the plugin's find-bash.mjs: same candidates, same Windows lookup", async () => {
  const dir = pluginDir({}, ROOT);
  assert.equal(dir, join(ROOT, "plugin"));
  const theirs = await import(pathToFileURL(join(dir, "scripts", "gate", "find-bash.mjs")).href);
  assert.deepEqual(theirs.candidates("C:/Git/mingw64/libexec/git-core"), candidates("C:/Git/mingw64/libexec/git-core"));
  const fallback = candidates("")[0];
  assert.match(fallback, /Program Files\\Git\\bin\\bash\.exe$/, "the fallback keeps its backslashes (the original bug)");
  assert.equal(theirs.findBash("win32", (p) => p === fallback, () => ""), fallback);
  assert.equal(findBash("win32", (p) => p === fallback, () => ""), fallback);
});

await t("pluginDir: MAPLE_PLUGIN_DIR wins; a root with no plugin and no env finds nothing from the repo", () => {
  assert.equal(pluginDir({ MAPLE_PLUGIN_DIR: join(ROOT, "plugin") }, join(ROOT, "nowhere")), join(ROOT, "plugin"));
  assert.equal(pluginDir({}, join(ROOT, "nowhere")) === join(ROOT, "plugin"), false);
});

await t("no Windows path in an escape-eating JS string anywhere in scripts/ or plugin/ (C:\\Program Files in a normal string)", () => {
  const bad = [];
  const re = /["'`]C:\\(?!\\)[A-Za-z]/; // a quote, then C:\ followed by a single backslash: an unescaped Windows path
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(mjs|js|cjs)$/.test(e.name) && e.name !== "run-gate.test.mjs") {
        const lines = readFileSync(f, "utf8").split("\n");
        lines.forEach((l, i) => { if (re.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l)) bad.push(`${f}:${i + 1}`); });
      }
    }
  };
  walk(join(ROOT, "scripts"));
  walk(join(ROOT, "plugin"));
  assert.deepEqual(bad, []);
});

console.log(`\nall ${n} run-gate tests passed`);
