// scrub-secrets PostToolUse hook: every pattern gets a positive and a near-miss negative. Runs the real hook as a
// child process (stdin payload -> stdout rewrite), so the contract is tested, not the internals.
// All fixtures are SYNTHETIC and assembled at runtime (no secret-shaped literal sits in this file, so secret
// scanners stay quiet and nothing real is ever printed). Run: node plugin/scripts/hooks/scrub-secrets.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOOK = join(ROOT, "plugin", "hooks", "scrub-secrets.mjs");

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };

/** The hook's updatedToolOutput for a Bash-shaped payload, or null when it leaves the output alone. */
function run(output, extra = {}) {
  const payload = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_output: output, ...extra };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout) return null;
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  return out.hookSpecificOutput.updatedToolOutput;
}

const rep = (chars, len) => chars.repeat(Math.ceil(len / chars.length)).slice(0, len);
const alnum = (len) => rep("Qw3Er7Ty1Ui5Op2As4Df6Gh8Jk0Lz9Xc", len);
const b64 = (len) => rep("Qw3/Er7+Ty1Ui5Op2As4Df6Gh8Jk0Lz9", len);
const hex = (len) => rep("0a1b2c3d4e5f", len);
const upper = (len) => rep("QWERTYUIOP1234ASDFGH", len);

const redacted = (out, kind) => out !== null && out.includes(`[REDACTED:${kind}]`);

// --- new in 0.13.4 (ported from EasyCaller's former project copy, D065 regression) ---

t("sb_secret_ key is redacted; sb_publishable_ (not a secret) and a too-short sb_secret_ are left alone", () => {
  const key = "sb_secret_" + alnum(30);
  assert.equal(run(`SUPABASE_SECRET_KEY=${key}\n`), "SUPABASE_SECRET_KEY=[REDACTED:sb_secret_key]\n");
  assert.equal(run("sb_publishable_" + alnum(30)), null);
  assert.equal(run("sb_secret_short"), null);
});

t("ASIA temporary AWS key is redacted; ASIA inside a longer word or a too-short id is not", () => {
  assert.equal(run("key ASIA" + upper(16) + " end"), "key [REDACTED:aws_temp_key] end");
  assert.equal(run("region ASIAPACIFICREGIONNAMES1"), null);
  assert.equal(run("ASIA" + upper(15)), null);
  assert.equal(run("XASIA" + upper(16)), null);
});

t("AWS secret access key is redacted by label (ini, env, JSON, any case); bare or wrong-length values are not", () => {
  const v = b64(40);
  assert.equal(run(`aws_secret_access_key = ${v}`), "aws_secret_access_key = [REDACTED:aws_secret]");
  assert.equal(run(`AWS_SECRET_ACCESS_KEY=${v}`), "AWS_SECRET_ACCESS_KEY=[REDACTED:aws_secret]");
  assert.equal(run(`"SecretAccessKey": "${v}",`), '"SecretAccessKey": "[REDACTED:aws_secret]",');
  assert.equal(run(`token ${v}`), null, "unlabeled 40 chars must not match");
  assert.equal(run(`aws_secret_access_key = ${b64(39)}`), null, "39 chars is not an AWS secret");
  assert.equal(run(`aws_secret_access_key = ${alnum(41)}`), null, "41 chars is not an AWS secret");
});

t("AWS session token is redacted by label; short or unlabeled values are not", () => {
  const v = b64(140) + "==";
  assert.equal(run(`aws_session_token=${v}`), "aws_session_token=[REDACTED:aws_session]");
  assert.equal(run(`"SessionToken": "${v}"`), '"SessionToken": "[REDACTED:aws_session]"');
  assert.equal(run(`blob ${v}`), null);
  assert.equal(run(`aws_session_token=${b64(60)}`), null);
});

t("Cloudflare API token is redacted by label; a bare 40-char value or a git SHA is not", () => {
  const v = alnum(40);
  assert.equal(run(`CLOUDFLARE_API_TOKEN=${v}`), "CLOUDFLARE_API_TOKEN=[REDACTED:cf_api_token]");
  assert.equal(run(`export CF_API_TOKEN="${v}"`), 'export CF_API_TOKEN="[REDACTED:cf_api_token]"');
  assert.equal(run(`deploy ${v}`), null);
  assert.equal(run(`api_token set; commit ${hex(40)}`), null, "a git SHA near the word api_token is not a token");
  assert.equal(run(`CLOUDFLARE_API_TOKEN=${alnum(39)}`), null);
});

t("Cloudflare global API key is redacted by label; 40-hex SHAs and unlabeled 37-hex are not", () => {
  const v = hex(37);
  assert.equal(run(`X-Auth-Key: ${v}`), "X-Auth-Key: [REDACTED:cf_global_key]");
  assert.equal(run(`CLOUDFLARE_API_KEY=${v}`), "CLOUDFLARE_API_KEY=[REDACTED:cf_global_key]");
  assert.equal(run(`id ${v}`), null);
  assert.equal(run(`X-Auth-Key: ${hex(40)}`), null, "a 40-hex SHA after the label is not a 37-hex key");
});

t("docs/ is scrubbed like everything else (the old docs skip is gone)", () => {
  const key = "sb_secret_" + alnum(30);
  for (const file_path of ["docs/setup.md", "C:\\repo\\docs\\setup.md", "/repo/docs/nested/a.md"]) {
    const out = run(`pasted: ${key}`, { tool_name: "Read", tool_input: { file_path }, cwd: ROOT });
    assert.equal(out, "pasted: [REDACTED:sb_secret_key]", file_path);
  }
});

t("PostToolUse matcher covers Bash, PowerShell, Read and Grep", () => {
  const hooks = JSON.parse(readFileSync(join(ROOT, "plugin", "hooks", "hooks.json"), "utf8")).hooks;
  const entry = hooks.PostToolUse.find((e) => e.hooks.some((h) => /scrub-secrets/.test(h.command)));
  assert.ok(entry, "scrub-secrets is registered on PostToolUse");
  const tools = entry.matcher.split("|");
  for (const tool of ["Bash", "PowerShell", "Read", "Grep"]) assert.ok(tools.includes(tool), tool);
});

// --- existing patterns keep working ---

t("existing catalog still redacts (AKIA, JWT, GitHub, Anthropic, Supabase PAT)", () => {
  assert.ok(redacted(run("AKIA" + upper(16)), "aws_key"));
  assert.ok(redacted(run("eyJ" + alnum(30) + ".eyJ" + alnum(30) + "." + alnum(20)), "jwt"));
  assert.ok(redacted(run("ghp_" + alnum(36)), "gh_pat"));
  assert.ok(redacted(run("sk-ant-" + alnum(60)), "anthropic"));
  assert.ok(redacted(run("sbp_" + alnum(40)), "sb_pat"));
  assert.equal(run("nothing secret here"), null);
});

t("a payload that is not JSON never crashes the hook", () => {
  const r = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

console.log(`\nall ${n} scrub-secrets tests passed`);
