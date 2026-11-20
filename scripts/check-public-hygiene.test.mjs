#!/usr/bin/env node
// check-public-hygiene.mjs contract, with made-up terms only (this file must itself stay clean).
// Run: node scripts/check-public-hygiene.test.mjs
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const { hashTerm, normalize, scanText } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "check-public-hygiene.mjs")).href);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };
const salt = "test-salt";
const hashes = new Set(["zorblax", "quux corp", "frob-nicate inc"].map((x) => hashTerm(x, salt)));
const scan = (text, extra) => scanText(text, { salt, hashes, extra });

t("normalize splits on punctuation and lower-cases", () => {
  assert.deepEqual(normalize("Quux-Corp's  ZORBLAX/x"), ["quux", "corp", "s", "zorblax", "x"]);
});
t("a hashed single word is found in any casing or punctuation", () => {
  assert.equal(scan("deploy Zorblax now").length, 1);
  assert.equal(scan("path/to/zorblax-app").length, 1);
});
t("hashed phrases match across hyphens and spacing", () => {
  assert.equal(scan("incident at Quux-Corp today").length, 1);
  assert.equal(scan("frob nicate, Inc.").length, 1);
  assert.equal(scan("quux alone is fine").length, 0);
});
t("ordinary text and substrings are not hits", () => {
  assert.equal(scan("zorblaxian is a different word").length, 0);
  assert.equal(scan("the caller passes a project").length, 0);
});
t("local plaintext extras work without hashes", () => {
  assert.equal(scan("ship it to Widgetron", ["widgetron"]).length, 1);
});
t("personal Windows paths and project-root paths are hits; placeholders are not", () => {
  const p = (...a) => a.join("\\");
  assert.equal(scan(`see ${p("C:", "Users", "Jane Doe", "x")}`).length, 1);
  assert.equal(scan(`see ${p("D:", "Projects", "thing")}`).length, 1);
  assert.equal(scan(`see ${p("C:", "Users", "<you>", ".claude")}`).length, 0);
  assert.equal(scan(`see ${p("C:", "Users", "%USERNAME%")}`).length, 0);
  assert.equal(scan("see %USERPROFILE%/.maple").length, 0);
});
t("e-mail addresses outside example domains are hits", () => {
  assert.equal(scan(["someone", "realmail.io"].join("@")).length, 1);
  assert.equal(scan("user@example.com and 1+bot@users.noreply.github.com").length, 0);
});
console.log(`\n${n} public-hygiene tests passed`);
