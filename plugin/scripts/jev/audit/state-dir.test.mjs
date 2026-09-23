import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import { resolveAuditStateDir } from "./state-dir.mjs";

const execFileAsync = promisify(execFile);

async function initGitRepo(dir) {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
}

test("resolveAuditStateDir uses <repo>/.maplelens/audit/<slug> when .maplelens is gitignored", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "maple-quality-state-"));
  await initGitRepo(dir);
  writeFileSync(join(dir, ".gitignore"), ".maplelens/*\n");
  const stateDir = await resolveAuditStateDir(dir, "myapp");
  assert.equal(stateDir, join(dir, ".maplelens", "audit", "myapp"));
});

test("resolveAuditStateDir falls back to the plugin's own per-user location when nothing gitignores .maplelens", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "maple-quality-state-"));
  await initGitRepo(dir);
  // no .gitignore at all
  const stateDir = await resolveAuditStateDir(dir, "myapp");
  assert.ok(!stateDir.startsWith(dir), `expected a location outside the repo, got ${stateDir}`);
  assert.match(stateDir, /maple-standard[\\/]quality-audit/);
  assert.ok(stateDir.endsWith(join("myapp")));
});

test("resolveAuditStateDir is stable and repo-specific for the plugin-owned fallback", async () => {
  const dirA = mkdtempSync(join(tmpdir(), "maple-quality-state-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "maple-quality-state-b-"));
  await initGitRepo(dirA);
  await initGitRepo(dirB);
  const a1 = await resolveAuditStateDir(dirA, "slug");
  const a2 = await resolveAuditStateDir(dirA, "slug");
  const b1 = await resolveAuditStateDir(dirB, "slug");
  assert.equal(a1, a2);
  assert.notEqual(a1, b1);
});
