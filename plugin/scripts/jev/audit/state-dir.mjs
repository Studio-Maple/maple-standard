#!/usr/bin/env node
/**
 * Where the audit's output/cache live for a given target repo.
 *
 * Per the porting brief: `<repo>/.maplelens/audit/<slug>/` ONLY when that
 * path is actually gitignored in the target repo (MapleLens itself: yes,
 * `.maplelens/*` with a `!.maplelens/desk.json` exception — the audit's
 * nested `audit/<slug>/...` files still match the directory-level ignore).
 * A repo with no such ignore rule never gets a NEW tracked-looking directory
 * from this script — cache/report land under this PLUGIN's own per-user
 * state location instead, keyed by the target repo's absolute path so two
 * repos never collide.
 *
 * Never writes a tracked file: this module only ever computes a path; every
 * caller is responsible for `mkdir -p` + writing under it, and nothing here
 * ever touches git add/commit.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Ask git itself whether `relPath` (a directory need not exist) would be ignored in `repoRoot`. */
export async function isGitIgnored(repoRoot, relPath) {
  try {
    await execFileAsync("git", ["check-ignore", "-q", relPath], { cwd: repoRoot });
    return true; // exit 0 -> ignored
  } catch (err) {
    // exit 1 -> not ignored; anything else (not a repo, git missing) -> treat as "can't tell, don't assume ignored"
    return false;
  }
}

/** Plugin-owned per-user cache root, same convention as jev/client.mjs's credential cache. */
function pluginStateRoot() {
  const base = process.env.LOCALAPPDATA || tmpdir();
  return join(base, "maple-standard", "quality-audit");
}

/** Deterministic, collision-safe folder name for a repo that doesn't gitignore `.maplelens/`. */
function repoStateKey(repoRoot) {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
}

/**
 * @param {string} repoRoot target repo root
 * @param {string} slug config slug (namespaces multiple configs under one repo/plugin state root)
 * @returns {Promise<string>} absolute directory path for report.json/report.html/cache.json/dup-cache.json
 */
export async function resolveAuditStateDir(repoRoot, slug) {
  const preferred = join(repoRoot, ".maplelens", "audit", slug);
  if (existsSync(join(repoRoot, ".git")) && (await isGitIgnored(repoRoot, ".maplelens/audit/probe"))) {
    return preferred;
  }
  return join(pluginStateRoot(), repoStateKey(repoRoot), slug);
}
