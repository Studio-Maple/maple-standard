#!/usr/bin/env node
/**
 * maple-secret.test.mjs - runs the REAL CLI as a child with a SYNTHETIC credential supplied through the
 * MAPLE_CRED_* env fallback (never the Credential Manager). Plain node + assert; exits non-zero on failure.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamRedactor } from "./redact.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "maple-secret.mjs");
const TARGET = "Test-Token";
const SECRET = 'syn+thetic/Tok en&"9=zZ';
const b64 = Buffer.from(SECRET).toString("base64");
const forms = { raw: SECRET, b64, b64url: Buffer.from(SECRET).toString("base64url"), url: encodeURIComponent(SECRET), json: JSON.stringify(SECRET).slice(1, -1) };

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${String(e.message).split("\n")[0]}`); }
}
function cli(args, extraEnv = {}) {
  const env = { ...process.env, MAPLE_CRED_TEST_TOKEN: SECRET, ...extraEnv };
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 30000 });
}
const node = (code) => ["--", process.execPath, "-e", code];
const noSecret = (out) => { for (const [k, f] of Object.entries(forms)) assert.ok(!out.includes(f), `form leaked: ${k}`); };

console.log("\n=== maple-secret ===");

test("child receives the value in env only; output is redacted in every form", () => {
  const code = `const v=process.env.TOK;const o=process.stdout;
    o.write("A:"+v+"\\n");o.write("B:"+Buffer.from(v).toString("base64")+"\\n");o.write("C:"+Buffer.from(v).toString("base64url")+"\\n");
    o.write("D:"+encodeURIComponent(v)+"\\n");o.write("E:"+JSON.stringify(v)+"\\n");console.error("F:"+v);`;
  const r = cli(["run", "--env", `TOK=${TARGET}`, ...node(code)]);
  assert.equal(r.status, 0);
  noSecret(r.stdout + r.stderr);
  assert.equal((r.stdout.match(/\[REDACTED:Test-Token\]/g) ?? []).length >= 5, true, r.stdout);
  assert.match(r.stderr, /F:\[REDACTED:Test-Token\]/);
});

test("a value split across two writes with a delay is still redacted", () => {
  const code = `const v=process.env.TOK;const h=Math.floor(v.length/2);process.stdout.write("x:"+v.slice(0,h));
    setTimeout(()=>process.stdout.write(v.slice(h)+":y\\n"),200);`;
  const r = cli(["run", "--env", `TOK=${TARGET}`, ...node(code)]);
  assert.equal(r.status, 0);
  noSecret(r.stdout);
  assert.match(r.stdout, /x:\[REDACTED:Test-Token\]:y/);
});

test("the secret is not inherited by name: MAPLE_CRED_* is stripped from the child env", () => {
  const r = cli(["run", "--env", `TOK=${TARGET}`, ...node(`console.log(Object.keys(process.env).filter(k=>k.startsWith("MAPLE_CRED_")).length)`)]);
  assert.equal(r.stdout.trim(), "0");
});

test("exit code passes through", () => {
  assert.equal(cli(["run", "--env", `TOK=${TARGET}`, ...node("process.exit(7)")]).status, 7);
  assert.equal(cli(["run", "--env", `TOK=${TARGET}`, ...node("process.exit(0)")]).status, 0);
});

test("--file: child reads the value (UTF-8, no BOM); the file is gone afterwards", () => {
  const code = `const fs=require("fs");const p=process.env.SECRET_FILE;const b=fs.readFileSync(p);
    console.log("PATH:"+p);console.log("BOM:"+(b[0]===0xEF&&b[1]===0xBB));console.log("LEN:"+b.length);console.log("SAME:"+(b.toString("utf8")===${JSON.stringify(SECRET)}));`;
  const r = cli(["run", "--file", `SECRET_FILE=${TARGET}`, ...node(code)]);
  assert.equal(r.status, 0, r.stderr);
  const path = /PATH:(.+)/.exec(r.stdout)?.[1]?.trim();
  assert.ok(path, r.stdout);
  assert.match(r.stdout, /BOM:false/);
  assert.match(r.stdout, new RegExp(`LEN:${Buffer.byteLength(SECRET)}`));
  assert.match(r.stdout, /SAME:true/);
  assert.equal(existsSync(path), false, "temp file still exists");
});

test("--file temp file is deleted even when the child fails", () => {
  const r = cli(["run", "--file", `SECRET_FILE=${TARGET}`, ...node('console.log("PATH:"+process.env.SECRET_FILE);process.exit(3)')]);
  assert.equal(r.status, 3);
  assert.equal(existsSync(/PATH:(.+)/.exec(r.stdout)[1].trim()), false);
});

test("missing target exits 2, names the target only, prints nothing value-like", () => {
  const r = cli(["run", "--env", "TOK=No-Such-Target-XYZ", ...node('console.log("ran")')], { MAPLE_CRED_TEST_TOKEN: SECRET });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /No-Such-Target-XYZ/);
  noSecret(r.stderr);
});

test("usage errors exit 64 and never run the command", () => {
  assert.equal(cli(["run", ...node("1")]).status, 64);
  assert.equal(cli(["run", "--env", "BAD NAME=x", ...node("1")]).status, 64);
  assert.equal(cli(["run", "--env", `TOK=${TARGET}`]).status, 64);
  assert.equal(cli(["bogus"]).status, 64);
});

test("exists prints true/false and never the value", () => {
  const yes = cli(["exists", TARGET]);
  assert.equal(yes.stdout.trim(), "true");
  noSecret(yes.stdout);
  assert.equal(cli(["exists", "No-Such-Target-XYZ"]).stdout.trim(), "false");
});

test("list prints names only (no value-like output)", () => {
  const r = cli(["list"]);
  assert.equal(r.status, 0);
  noSecret(r.stdout);
});

test("StreamRedactor: byte-at-a-time feed, short values and multiple secrets", () => {
  const red = new StreamRedactor([{ target: "A", value: "abc" }, { target: "B", value: SECRET }]);
  const text = `pre abc mid ${SECRET} post ${Buffer.from("abc").toString("base64")}`;
  let out = "";
  for (const ch of text) out += red.push(ch);
  out += red.end();
  assert.equal(out, "pre [REDACTED:A] mid [REDACTED:B] post [REDACTED:A]");
});

test("StreamRedactor: no secrets -> passthrough", () => {
  const red = new StreamRedactor([]);
  assert.equal(red.push("hello") + red.end(), "hello");
});

test("the CLI source never reads the value into argv/log: no console.log of values", () => {
  const src = readFileSync(CLI, "utf8");
  assert.ok(!/console\.(log|error)\([^)]*value/.test(src));
});

console.log(`\n${passed}/${passed + failed} maple-secret tests passed`);
process.exit(failed ? 1 : 0);
