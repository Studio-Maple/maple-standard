#!/usr/bin/env node
/**
 * check-dep-freshness.mjs — D064's diff-scoped ci:fast gate.
 *
 * For every package.json that differs from the merge-base with the target branch (maple.config.json
 * `repo.devBranch`, else the origin default branch, else `main`; committed, staged, unstaged and new
 * files all count), each dependency ADDED or whose version spec CHANGED must not be behind the latest
 * eligible release's major (0.x: minor). Untouched dependencies are never checked here — Dependabot
 * owns drift. "Latest eligible" = the registry `latest` tag, or, when pnpm `minimumReleaseAge` is set
 * in pnpm-workspace.yaml, the newest non-prerelease version older than that window.
 *
 * workspace: / file: / link: / git / url specs are skipped; `npm:` aliases are checked against their
 * target. A registry that cannot be reached FAILS the gate (a gate that cannot check must not pass).
 * Exceptions: maple.config.json `deps.exceptions`, each citing a D### that exists in the decisions ledger.
 *
 * CLI: `node check-dep-freshness.mjs` (project root = $CLAUDE_PROJECT_DIR or cwd). Exit 1 on any failure.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadMapleConfig } from "../docs/lib/config.mjs";
import { loadExceptions } from "./exceptions.mjs";
import { judgeDep, staleMessage } from "./freshness.mjs";
import { diffDeps } from "./pkgjson.mjs";
import { fetchLatestEligible, readMinReleaseAge } from "./registry.mjs";

function defaultGit(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

const tryGit = (git, root, args) => {
  try {
    return git(root, args).trim();
  } catch {
    return null;
  }
};

/** merge-base of HEAD with the target branch: devBranch -> origin default -> main. null when none resolves. */
export function resolveBase(root, git = defaultGit) {
  const cfg = loadMapleConfig(root)?.repo ?? {};
  const remote = cfg.remote || "origin";
  const originHead = tryGit(git, root, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  const names = [cfg.devBranch, originHead?.replace(`refs/remotes/${remote}/`, ""), "main"].filter(Boolean);
  for (const name of [...new Set(names)]) {
    for (const ref of [`${remote}/${name}`, name]) {
      const base = tryGit(git, root, ["merge-base", "HEAD", ref]);
      if (base) return { base, ref };
    }
  }
  return null;
}

/** package.json files that differ from `base` (working tree included) plus untracked ones, repo-relative to `root`. */
export function changedPackageJsons(root, base, git = defaultGit) {
  const listed = [
    git(root, ["diff", "--name-only", "--relative", "--diff-filter=d", base]),
    git(root, ["ls-files", "--others", "--exclude-standard"]),
  ].join("\n");
  return [...new Set(listed.split(/\r?\n/).filter((f) => f && basename(f) === "package.json" && !f.split("/").includes("node_modules")))];
}

function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Run the gate. Returns `{ errors, lines }` (lines are the report; errors the failing count).
 * `fetchImpl` / `git` / `now` are injectable for tests.
 */
export async function run({ root, base, git = defaultGit, fetchImpl = fetch, now, timeoutMs = 15_000 } = {}) {
  const lines = [];
  let errors = 0;
  const fail = (msg) => { errors += 1; lines.push(`[error] ${msg}`); };

  const { valid, problems } = loadExceptions(root);
  for (const p of problems) fail(`invalid exception: ${p}`);

  // `base` (heavy tier, D066): every dependency changed since the last green heavy run, not just since the merge-base.
  const resolved = base ? { base, ref: base.slice(0, 10) } : resolveBase(root, git);
  if (!resolved) {
    fail("dep-freshness: cannot resolve the target branch to diff against (tried repo.devBranch, the origin default branch, main) — set repo.devBranch in maple.config.json.");
    return { errors, lines };
  }

  const files = changedPackageJsons(root, resolved.base, git);
  const changes = [];
  for (const file of files) {
    let after;
    try { after = readJson(readFileSync(join(root, file), "utf8")); } catch { after = null; }
    if (after === null) { lines.push(`[warn] ${file}: not valid JSON, skipped`); continue; }
    const beforeText = tryGit(git, root, ["show", `${resolved.base}:./${file}`]);
    const before = beforeText ? (readJson(beforeText) ?? {}) : {};
    for (const d of diffDeps(before, after)) changes.push({ file, ...d });
  }
  if (changes.length === 0) {
    lines.push(`dep-freshness: no dependency added or changed vs ${resolved.ref} (${files.length} package.json changed).`);
    return { errors, lines };
  }

  const minAgeMinutes = readMinReleaseAge(root);
  const cache = new Map();
  const latestFor = (pkg) => {
    if (!cache.has(pkg)) cache.set(pkg, fetchLatestEligible(pkg, { minAgeMinutes, fetchImpl, timeoutMs, now }));
    return cache.get(pkg);
  };
  const tally = { ok: 0, skipped: 0, excepted: 0 };
  const verdicts = await Promise.all(changes.map(async (c) => ({ c, r: await judgeDep({ name: c.name, spec: c.spec }, { latestFor, exceptions: valid }) })));
  for (const { c, r } of verdicts) {
    if (r.status === "stale") fail(`${c.file}: ${c.section}: ${staleMessage(c.name, c.spec, r.latest)}`);
    else if (r.status === "unreachable") fail(`${c.file}: ${c.name}@${c.spec}: registry unreachable (${r.reason}) — cannot verify freshness; a gate that cannot check does not pass.`);
    else tally[r.status] += 1;
    if (r.status === "excepted") lines.push(`[note] ${c.file}: ${c.name}@${c.spec} behind ${r.latest}, excepted by ${r.decision}`);
  }
  const age = minAgeMinutes ? `, minimumReleaseAge ${minAgeMinutes} min` : "";
  lines.push(`dep-freshness: ${changes.length} added/changed dependenc${changes.length === 1 ? "y" : "ies"} vs ${resolved.ref}${age}: ${tally.ok} current, ${tally.excepted} excepted, ${tally.skipped} skipped, ${errors} failing.`);
  return { errors, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bi = process.argv.indexOf("--base");
  const { errors, lines } = await run({ root: process.env.CLAUDE_PROJECT_DIR || process.cwd(), base: bi > 0 ? process.argv[bi + 1] : undefined });
  for (const l of lines) (l.startsWith("[error]") ? console.error : console.log)(l);
  process.exit(errors > 0 ? 1 : 0);
}
