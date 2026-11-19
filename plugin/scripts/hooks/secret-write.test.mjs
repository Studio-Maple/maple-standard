#!/usr/bin/env node
// secret-write-guard (Write/Edit/MultiEdit/NotebookEdit + MCP FileSystem write) through the real dispatcher.
// Secret-shaped values are assembled at runtime so no secret-shaped literal sits in this file.
// Run: node plugin/scripts/hooks/secret-write.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { evaluate } = await import(pathToFileURL(join(HERE, "..", "..", "hooks", "guard.mjs")).href);

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };
const rep = (chars, len) => chars.repeat(Math.ceil(len / chars.length)).slice(0, len);
const GHP = "gh" + "p_" + rep("Qw3Er7Ty1Ui5Op2As4Df6Gh8Jk0Lz9Xc", 36);
const AKIA = "AK" + "IA" + rep("QWERTYUIOP234567", 16);
const STORE = "Get-" + "StoredCredential";

function project(security) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "secwrite-"))).replace(/\\/g, "/");
  writeFileSync(join(root, "maple.config.json"), JSON.stringify({ project: { name: "t", slug: "t" }, ...(security ? { security } : {}) }));
  return root;
}
const verdict = (r) => (r.deny ? "deny" : r.ask ? "ask" : r.warns.length ? "warn" : "allow");
const run = (root, tool, input) => evaluate({ tool_name: tool, tool_input: input, cwd: root });

const enforce = project({ mode: "enforce" });
const warn = project();
try {
  await t("Write with a GitHub PAT is denied in enforce mode", async () => {
    const r = await run(enforce, "Write", { file_path: `${enforce}/src/config.ts`, content: `export const token = "${GHP}";\n` });
    assert.equal(verdict(r), "deny");
    assert.match(r.deny, /gh_pat/);
    assert.ok(!r.deny.includes(GHP), "the message never echoes the value");
  });
  await t("the same write only warns with no security block (warn mode) ", async () => {
    const r = await run(warn, "Write", { file_path: `${warn}/src/config.ts`, content: `const k = "${AKIA}";` });
    assert.equal(verdict(r), "warn");
    assert.match(r.warns.join("\n"), /warn mode/);
  });
  await t("Edit adding a key is denied; an edit that keeps an existing one is not blamed", async () => {
    assert.equal(verdict(await run(enforce, "Edit", { file_path: `${enforce}/a.js`, old_string: "x", new_string: `x = "${AKIA}"` })), "deny");
    assert.equal(verdict(await run(enforce, "Edit", { file_path: `${enforce}/a.js`, old_string: `k = "${AKIA}"; y = 1`, new_string: `k = "${AKIA}"; y = 2` })), "allow");
  });
  await t("MultiEdit and NotebookEdit are scanned", async () => {
    assert.equal(verdict(await run(enforce, "MultiEdit", { file_path: `${enforce}/a.js`, edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: GHP }] })), "deny");
    assert.equal(verdict(await run(enforce, "NotebookEdit", { notebook_path: `${enforce}/n.ipynb`, new_source: `t = '${GHP}'` })), "deny");
  });
  await t("MCP FileSystem write is scanned like Write", async () => {
    const r = await run(enforce, "mcp__Windows-MCP__FileSystem", { mode: "write", path: `${enforce}/x.txt`, content: GHP });
    assert.equal(verdict(r), "deny");
  });
  await t("allowPaths exempts a fixture folder", async () => {
    const root = project({ mode: "enforce", controls: { secretWrite: { allowPaths: ["test/fixtures/**"] } } });
    try {
      assert.equal(verdict(await run(root, "Write", { file_path: `${root}/test/fixtures/leak.txt`, content: GHP })), "allow");
      assert.equal(verdict(await run(root, "Write", { file_path: `${root}/src/leak.txt`, content: GHP })), "deny");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  await t("secretWrite off disables the catalog check", async () => {
    const root = project({ controls: { secretWrite: "off" } });
    try { assert.equal(verdict(await run(root, "Write", { file_path: `${root}/a.txt`, content: GHP })), "allow"); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  await t("high-entropy literal on a secret-looking key warns, placeholders do not", async () => {
    const hi = await run(enforce, "Write", { file_path: `${enforce}/c.ts`, content: `const apiKey = "Zq8vN2xLr5Tb9Wk3Hc7Pm1Ys4Dg6Jf0A";` });
    assert.equal(verdict(hi), "warn");
    const ph = await run(enforce, "Write", { file_path: `${enforce}/c.ts`, content: `const apiKey = "your-api-key-goes-here-000000";\nconst token = process.env.TOKEN;` });
    assert.equal(verdict(ph), "allow");
  });
  await t("a script calling the credential store is denied even in warn mode (D085)", async () => {
    const r = await run(warn, "Write", { file_path: `${warn}/scripts/deploy.ps1`, content: `$t = (${STORE} -Target 'X').GetNetworkCredential().Password` });
    assert.equal(verdict(r), "deny");
    assert.match(r.deny, /maple-secret/);
  });
  await t("docs may name the store APIs; the plugin's own helpers may call them", async () => {
    assert.equal(verdict(await run(warn, "Write", { file_path: `${warn}/docs/secrets.md`, content: `Never call ${STORE} yourself.` })), "allow");
    assert.equal(verdict(await run(warn, "Write", { file_path: `${warn}/plugin/scripts/secrets/x.mjs`, content: `const s = "${STORE}";` })), "allow");
  });
  await t("a Write over an existing script that already calls the store is not blamed (migration path)", async () => {
    const file = `${warn}/scripts/old-deploy.ps1`;
    const { mkdirSync } = await import("node:fs");
    mkdirSync(`${warn}/scripts`, { recursive: true });
    writeFileSync(file, `$t = (${STORE} -Target 'X')\n`);
    assert.equal(verdict(await run(warn, "Write", { file_path: file, content: `# tidied\n$t = (${STORE} -Target 'X')\n` })), "allow");
  });
  await t("clean writes pass", async () => {
    assert.equal(verdict(await run(enforce, "Write", { file_path: `${enforce}/README.md`, content: "# hello\n" })), "allow");
  });
} finally {
  rmSync(enforce, { recursive: true, force: true });
  rmSync(warn, { recursive: true, force: true });
}
console.log(`\n${n} secret-write tests passed`);
