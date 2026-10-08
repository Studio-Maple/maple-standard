// checkov must ACTUALLY RUN (a rejected --config-file once made it silently never run) and must FAIL on a
// planted finding. Needs Docker (the checkov image is pulled when absent) — there is no skip: a gate whose
// scanner cannot run is a failed gate, and so is this test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main as runGate } from "./run.mjs";
import { headSha } from "./lib.mjs";
import { reportPath } from "./state.mjs";

const repo = mkdtempSync(join(tmpdir(), "predeploy-checkov-"));
const sh = (args) => { const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, args.join(" ") + r.stderr); return r.stdout.trim(); };
sh(["init", "-q"]); sh(["config", "user.email", "t@t"]); sh(["config", "user.name", "t"]); sh(["config", "commit.gpgsign", "false"]);
const cfg = { project: { name: "t", slug: "t" }, predeploy: { checks: [{ id: "checkov", preset: "checkov", options: { dirs: ["infra"] } }], exposure: { optOut: { bundle: { decision: "D161", why: "fixture repo: no web build to scan (the D072 opt-out path)" } } } } };
const commit = (files) => {
  writeFileSync(join(repo, "maple.config.json"), JSON.stringify(cfg, null, 2));
  files = { "docs/decisions.md": "# Decisions\n\n## D161 | 2026-10-01 | Test exception decision\nbody\n", ...files };
  for (const [k, v] of Object.entries(files)) { mkdirSync(dirname(join(repo, k)), { recursive: true }); writeFileSync(join(repo, k), v); }
  sh(["add", "-A"]); sh(["commit", "-q", "-m", "c", "--allow-empty"]);
};
const gate = async () => { const log = console.log; console.log = () => {}; try { return await runGate(["--root", repo, "--pull"]); } finally { console.log = log; } };
const report = () => JSON.parse(readFileSync(reportPath(repo, headSha(repo)), "utf8"));
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

const PLANTED = 'resource "aws_s3_bucket" "b" {\n  bucket = "planted"\n  acl    = "public-read"\n}\n';
// a repo-level .checkov.yaml that tries to skip the very rule we planted: the gate must not honour it
commit({ "infra/main.tf": PLANTED, ".checkov.yaml": "skip-check:\n  - CKV_AWS_20\n" });

await t("checkov runs (no tool/report/parse failure) and FAILS on a planted public bucket", async () => {
  assert.equal(await gate(), 1);
  const r = report();
  const ids = r.blocking.map((f) => f.id);
  for (const bad of ["no-report", "unparseable-report", "tool-missing", "checkov-parse-error", "check-crashed", "spawn-failed"]) assert.ok(!ids.includes(bad), `${bad} in ${ids}`);
  assert.ok(r.blocking.length > 0, "checkov must report findings");
  assert.ok(ids.includes("CKV_AWS_20"), "the planted public-read ACL must be caught even though .checkov.yaml tries to skip it: " + ids);
  const planted = r.blocking.find((f) => f.id === "CKV_AWS_20");
  assert.equal(planted.resource, "aws_s3_bucket.b"); assert.equal(planted.location.split(":")[0], "infra/main.tf");
});

await t("every checkov finding can be backed by an exact file#resource decision entry; stale entries then fail", async () => {
  const blocking = report().blocking;
  const seen = new Set();
  const entries = [];
  for (const f of blocking) {
    const scope = `${f.location.split(":")[0]}#${f.resource}`;
    if (seen.has(f.id + scope)) continue;
    seen.add(f.id + scope);
    entries.push({ scanner: "checkov", rule: f.id, scope, decision: "D162", why: "test fixture: planted finding, intentionally unfixable here", reviewed: new Date().toISOString().slice(0, 10) });
  }
  commit({ "docs/decisions.md": "# Decisions\n\n## D162 | 2026-10-01 | Fixture decision\nbody\n\n## D161 | 2026-10-01 | Test exception decision\nbody\n", "predeploy-decisions.json": JSON.stringify({ version: 1, entries }) });
  assert.equal(await gate(), 0, JSON.stringify(report().blocking));
  assert.equal(report().totals.decisionBacked, blocking.length); assert.equal(report().totals.blocking, 0);
  commit({ "infra/main.tf": PLANTED.replace('"b"', '"renamed"') });
  assert.equal(await gate(), 1);
  const ids = report().blocking.map((f) => f.id);
  assert.ok(ids.includes("decision-stale"), ids.join(","));
});

console.log(`\n${n} checkov tests passed`);
rmSync(repo, { recursive: true, force: true });
