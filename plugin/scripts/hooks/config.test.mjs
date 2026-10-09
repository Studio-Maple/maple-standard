#!/usr/bin/env node
// Config contract for the D065 guards: supabase.devProjectRefs/prodProjectRefs, hooks.bashGuard.cleanGuardEnabled,
// an explicitly empty predeploy.deployGuard.patterns is an error, and pi-run computes the MAIN root so a run
// from inside a linked worktree never nests. Plain node, non-zero on failure.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const mod = (...p) => import(pathToFileURL(join(HERE, "..", ...p)).href);
const { validateConfig } = await mod("validate-config.mjs");
const { validatePredeploy } = await mod("predeploy", "config.mjs");
const { mainRootOf } = await mod("jev", "pi-run.mjs");
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };
const base = { project: { name: "t", slug: "t" } };

await t("supabase refs validate", () => {
  assert.deepEqual(validateConfig({ ...base, supabase: { devProjectRefs: ["abc"], prodProjectRefs: ["def"] } }), []);
  assert.deepEqual(validateConfig({ ...base, supabase: { devProjectRefs: [] } }), []);
  assert.match(validateConfig({ ...base, supabase: { devProjectRefs: "abc" } }).join("\n"), /devProjectRefs/);
  assert.match(validateConfig({ ...base, supabase: { devProjectRefs: [""] } }).join("\n"), /non-empty/);
  assert.match(validateConfig({ ...base, supabase: { devProjectRefs: ["a"], prodProjectRefs: ["a"] } }).join("\n"), /both a dev and a prod/);
  assert.match(validateConfig({ ...base, supabase: { stagingRefs: [] } }).join("\n"), /stagingRefs/);
});

await t("hooks.bashGuard.cleanGuardEnabled is a known boolean", () => {
  assert.deepEqual(validateConfig({ ...base, hooks: { bashGuard: { cleanGuardEnabled: false } } }), []);
  assert.match(validateConfig({ ...base, hooks: { bashGuard: { cleanGuardEnabled: "no" } } }).join("\n"), /cleanGuardEnabled/);
});

await t("hooks.bashGuard.linkGuardEnabled is a known boolean", () => {
  assert.deepEqual(validateConfig({ ...base, hooks: { bashGuard: { linkGuardEnabled: false } } }), []);
  assert.match(validateConfig({ ...base, hooks: { bashGuard: { linkGuardEnabled: "no" } } }).join("\n"), /linkGuardEnabled/);
});

await t("an explicitly empty deployGuard.patterns is an error; omitted or non-empty is fine", () => {
  const cfg = (g) => ({ predeploy: { checks: [{ id: "a", command: "node -e 0" }], ...(g === undefined ? {} : { deployGuard: g }) } });
  assert.match(validatePredeploy(cfg({ patterns: [] })).join("\n"), /explicitly empty/);
  assert.equal(validatePredeploy(cfg(undefined)).filter((e) => /patterns/.test(e)).length, 0);
  assert.equal(validatePredeploy(cfg({})).filter((e) => /patterns/.test(e)).length, 0);
  assert.equal(validatePredeploy(cfg({ patterns: [{ id: "x", regex: "deploy\\.sh" }] })).filter((e) => /patterns/.test(e)).length, 0);
});

await t("pi-run: the worktree root is the MAIN checkout even when started inside a linked worktree", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pirun-")));
  try {
    const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
    mkdirSync(join(root, ".worktrees"));
    git("worktree", "add", "-q", ".worktrees/w1", "-b", "agent/w1");
    const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
    assert.equal(norm(await mainRootOf(root)), norm(root));
    assert.equal(norm(await mainRootOf(join(root, ".worktrees", "w1"))), norm(root));
    assert.equal(norm(await mainRootOf(tmpdir())), norm(tmpdir()), "outside a repo it falls back to the given root");
    git("worktree", "remove", "--force", ".worktrees/w1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${n} config checks passed`);
