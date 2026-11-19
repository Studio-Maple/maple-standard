#!/usr/bin/env node
// precommit-secrets.mjs against real temp repos and the real gitleaks binary (integration: needs gitleaks).
// The secret-shaped value is assembled at runtime. Run: node plugin/scripts/prepush/run-tests.mjs --integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "precommit-secrets.mjs");
const GHP = "gh" + "p_" + "Qw3Er7Ty1Ui5Op2As4Df6Gh8Jk0Lz9Xc".repeat(2).slice(0, 36);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };

if (spawnSync("gitleaks", ["version"], { windowsHide: true }).status !== 0) {
  console.error("FAIL: gitleaks is not installed; the integration set needs it (scoop install gitleaks)");
  process.exit(1);
}

function repo(config, content) {
  const root = mkdtempSync(join(tmpdir(), "pcs-"));
  spawnSync("git", ["init", "-q", root]);
  if (config) writeFileSync(join(root, "maple.config.json"), JSON.stringify(config));
  writeFileSync(join(root, "a.txt"), content);
  spawnSync("git", ["-C", root, "add", "a.txt"]);
  return root;
}
const run = (root) => spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8", windowsHide: true });

const dirs = [];
try {
  t("enforce: a staged secret fails the commit, and the value is redacted", () => {
    const r = run(dirs[dirs.push(repo({ security: { mode: "enforce" } }, `token = "${GHP}"\n`)) - 1]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /SECRET FOUND/);
    assert.ok(!(r.stdout + r.stderr).includes(GHP), "the secret never reaches the output");
  });
  t("no security block (warn): reported, commit allowed", () => {
    const r = run(dirs[dirs.push(repo(null, `token = "${GHP}"\n`)) - 1]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /warn mode/);
  });
  t("enforceAfter in the past acts as enforce", () => {
    const r = run(dirs[dirs.push(repo({ security: { enforceAfter: "2020-01-01" } }, `token = "${GHP}"\n`)) - 1]);
    assert.equal(r.status, 1);
  });
  t("gitHooks off skips the scan", () => {
    const r = run(dirs[dirs.push(repo({ security: { mode: "enforce", controls: { gitHooks: "off" } } }, `token = "${GHP}"\n`)) - 1]);
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, "");
  });
  t("enforce: clean staged changes pass", () => {
    const r = run(dirs[dirs.push(repo({ security: { mode: "enforce" } }, "hello\n")) - 1]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK/);
  });
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
console.log(`\n${n} precommit-secrets tests passed`);
