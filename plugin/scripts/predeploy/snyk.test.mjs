// snyk preset: a fake `snyk` CLI on PATH; the token comes from the env credential path (MAPLE_CRED_*), is handed to
// the child as SNYK_TOKEN only, never appears in a finding, and every failure mode is a finding (never a skip).
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PRESETS } from "./catalog.mjs";
import { envNameFor } from "./credentials.mjs";

const bin = mkdtempSync(join(tmpdir(), "snyk-fake-"));
const impl = join(bin, "snyk-fake.js");
writeFileSync(impl, `
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.0.0-fake"); process.exit(0); }
const mode = process.env.FAKE_SNYK_MODE || "vulns";
const tok = process.env.SNYK_TOKEN || "";
if (mode === "auth") { console.log(JSON.stringify({ ok: false, error: "Authentication failed. Please check the API token on https://snyk.io " + tok, path: "/x" })); process.exit(2); }
if (mode === "none") { console.log(JSON.stringify([])); process.exit(3); }
if (mode === "garbage") { console.error("boom " + tok); process.exit(2); }
console.log(JSON.stringify([
  { displayTargetFile: "package-lock.json", vulnerabilities: [
    { id: "SNYK-JS-A-1", severity: "high", packageName: "a", version: "1.0.0", title: "token seen:" + (tok.length) + " args:" + args.join(" ") },
    { id: "SNYK-JS-A-1", severity: "high", packageName: "a", version: "1.0.0", title: "dup" },
    { id: "SNYK-JS-B-2", severity: "low", packageName: "b", version: "2.0.0", title: "low one" } ] },
  { displayTargetFile: "services/x/package-lock.json", vulnerabilities: [] } ]));
process.exit(1);
`);
if (process.platform === "win32") writeFileSync(join(bin, "snyk.cmd"), `@node "%~dp0snyk-fake.js" %*\r\n`);
else { writeFileSync(join(bin, "snyk"), `#!/bin/sh\nexec node "$(dirname "$0")/snyk-fake.js" "$@"\n`); chmodSync(join(bin, "snyk"), 0o755); }
process.env.PATH = bin + delimiter + process.env.PATH;

const TOKEN = "s3cr3t-token-value-0123456789";
const TARGET = "Test-Snyk-Target";
const ctx = { scanRoot: tmpdir(), docker: false, pull: false };
const run = (opts = {}) => PRESETS.snyk.run({ tokenCredential: TARGET, ...opts }, ctx);
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

await t("a missing token is a finding naming the credential, never a skip", async () => {
  delete process.env[envNameFor(TARGET)];
  const r = await run({ tokenCredential: "Nonexistent-Snyk-Target-xyz" });
  assert.equal(r.findings[0].id, "token-missing"); assert.match(r.findings[0].message, /Nonexistent-Snyk-Target-xyz/);
});

process.env[envNameFor(TARGET)] = TOKEN;
await t("vulnerabilities become findings (deduplicated, every severity), with --dev and --all-projects", async () => {
  const r = await run();
  assert.deepEqual(r.findings.map((f) => f.id).sort(), ["SNYK-JS-A-1", "SNYK-JS-B-2"]);
  const a = r.findings.find((f) => f.id === "SNYK-JS-A-1");
  assert.equal(a.resource, "a@1.0.0"); assert.equal(a.severity, "high"); assert.equal(a.location, "package-lock.json");
  assert.match(a.message, /token seen:\d+/); assert.match(a.message, /--all-projects --dev --severity-threshold=low --json/);
  assert.ok(r.findings.some((f) => f.id === "SNYK-JS-B-2" && f.severity === "low"));
});
await t("the token reaches the child as SNYK_TOKEN but is never in a finding or note", async () => {
  const r = await run();
  assert.ok(!JSON.stringify(r).includes(TOKEN)); assert.equal(process.env.SNYK_TOKEN, undefined, "never set in the gate process");
  assert.match(r.findings[0].message, new RegExp(`token seen:${TOKEN.length}`));
});
for (const [mode, id] of [["auth", "snyk-auth-failed"], ["none", "snyk-no-projects"], ["garbage", "snyk-failed"]]) {
  await t(`${mode}: ${id} is a finding and the token is scrubbed from it`, async () => {
    process.env.FAKE_SNYK_MODE = mode;
    const r = await run();
    assert.ok(r.findings.some((f) => f.id === id), JSON.stringify(r.findings));
    assert.ok(!JSON.stringify(r).includes(TOKEN));
  });
}
console.log(`\n${n} snyk tests passed`);
