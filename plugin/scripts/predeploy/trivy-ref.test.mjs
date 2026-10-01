// trivy-image in {name, ref} mode: a THIRD-PARTY image run as-is must be pulled by its exact deployed ref and
// scanned, and an unpullable ref must be a finding, never a skip. Needs Docker + network (images are pulled when
// absent) — there is no skip: an image the gate cannot scan is a hole, and so is this test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as runGate } from "./run.mjs";
import { headSha } from "./lib.mjs";
import { reportPath } from "./state.mjs";

const repo = mkdtempSync(join(tmpdir(), "predeploy-trivyref-"));
const sh = (args) => { const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, args.join(" ") + r.stderr); return r.stdout.trim(); };
sh(["init", "-q"]); sh(["config", "user.email", "t@t"]); sh(["config", "user.name", "t"]); sh(["config", "commit.gpgsign", "false"]);
const commit = (images) => {
  const cfg = { project: { name: "t", slug: "t" }, predeploy: { checks: [{ id: "images", preset: "trivy-image", options: { images } }] } };
  writeFileSync(join(repo, "maple.config.json"), JSON.stringify(cfg, null, 2));
  sh(["add", "-A"]); sh(["commit", "-q", "-m", "c", "--allow-empty"]);
};
const gate = async () => { const log = console.log; console.log = () => {}; try { return await runGate(["--root", repo, "--pull"]); } finally { console.log = log; } };
const report = () => JSON.parse(readFileSync(reportPath(repo, headSha(repo)), "utf8"));
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

await t("a pinned third-party ref is pulled and scanned: findings are attributed to the image name", async () => {
  commit([{ name: "old-alpine", ref: "alpine:3.12", platform: "linux/amd64" }]);
  assert.equal(await gate(), 1);
  const r = report();
  const ids = r.blocking.map((f) => f.id);
  for (const bad of ["image-pull-failed", "image-save-failed", "image-build-failed", "tool-missing", "check-crashed", "no-report", "unparseable-report"]) assert.ok(!ids.includes(bad), `${bad} in ${ids.slice(0, 5)}`);
  assert.ok(r.blocking.length > 0, "an EOL alpine must have known vulnerabilities");
  assert.ok(r.blocking.every((f) => f.location.startsWith("old-alpine: ")), r.blocking[0].location);
  assert.ok(r.blocking.some((f) => /^CVE-/.test(f.id) && /^[^@]+@/.test(f.resource || "")), "vulnerabilities carry package@version as resource");
});

await t("an unpullable ref is a finding, not a skip; ref + context together is rejected", async () => {
  commit([{ name: "ghost", ref: "registry.invalid/does/not-exist:1" }]);
  assert.equal(await gate(), 1);
  assert.ok(report().blocking.some((f) => f.id === "image-pull-failed"));
  commit([{ name: "both", ref: "alpine:3.12", context: "." }]);
  assert.equal(await gate(), 1);
  assert.ok(report().blocking.some((f) => f.id === "misconfigured"));
});

console.log(`\n${n} trivy-ref tests passed`);
rmSync(repo, { recursive: true, force: true });
