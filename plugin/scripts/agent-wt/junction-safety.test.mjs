#!/usr/bin/env node
/**
 * junction-safety.test.mjs — regression test for the gutted-node_modules
 * incident (maple-pole, 2026-07-28..30, D049 there).
 *
 * `git worktree remove --force` FOLLOWS NTFS junctions during its recursive
 * delete: it empties the junction TARGET and leaves the dir. Next.js/
 * Turbopack writes junctions under `.next/node_modules/`
 * (require-in-the-middle-<hash> / import-in-the-middle-<hash> — the Sentry
 * require-hook packages Next externalizes) targeting the MAIN checkout's
 * real `.pnpm` package dirs, so tearing down a worktree gutted the main
 * tree's real packages three times in three days. maple_remove_worktree
 * must strip every reparse point inside the worktree (the links themselves,
 * never their targets) before any deleter runs.
 *
 * D069 (2026-10-07, EasyCaller): the removal is also FAIL-CLOSED. A plugin
 * cache update deleted the lib's own dir mid-reap, the strip silently
 * no-oped, and only luck saved the main node_modules. Scenarios:
 *   (a) strip tool missing  -> refuse loudly, delete nothing
 *   (b) strip "succeeds" but a link remains -> the independent re-scan refuses
 *   (c) normal path -> link stripped, worktree gone, sentinel survives
 * On POSIX every deleter unlinks symlinks safely, so (c) passes trivially
 * there; the Windows-specific regression runs for real on Windows machines.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
// Git Bash paths: forward slashes keep bash from eating backslashes.
const posixish = (p) => p.replaceAll("\\", "/");

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

// bash is required to source maple-lib.sh (Git Bash on Windows). A machine
// without it can't run the worktree flow at all — skip, don't fail.
if (sh("bash", ["-c", "echo ok"]).status !== 0) {
  console.log("SKIP: bash not on PATH — the agent-wt scripts (and this test) need it.");
  process.exit(0);
}

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

/** Sandbox: main/pkg sentinel + a repo + a worktree holding a link to the sentinel. */
function scenario(sb) {
  const mainPkg = join(sb, "main", "pkg");
  mkdirSync(mainPkg, { recursive: true });
  writeFileSync(join(mainPkg, "a.js"), "real file A\n");
  writeFileSync(join(mainPkg, "b.js"), "real file B\n");
  const repo = join(sb, "repo");
  mkdirSync(repo);
  sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
  sh(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: repo },
  );
  const wt = join(sb, "wtree");
  const add = sh("git", ["worktree", "add", "-q", wt, "-b", "tbr"], { cwd: repo });
  if (add.status !== 0) {
    console.log(`SKIP: git worktree add failed in the sandbox — ${String(add.stderr).trim()}`);
    process.exit(0);
  }
  // The hazard: a link inside build output whose target is OUTSIDE the
  // worktree — exactly what Turbopack leaves in .next/node_modules/.
  const linkParent = join(wt, ".next", "node_modules");
  mkdirSync(linkParent, { recursive: true });
  const link = join(linkParent, "pkg-hash123");
  if (IS_WIN) {
    const mk = sh("cmd", ["/c", "mklink", "/J", link, mainPkg]);
    if (mk.status !== 0) {
      console.log(`SKIP: cannot create a junction here — ${String(mk.stderr).trim()}`);
      process.exit(0);
    }
  } else {
    sh("ln", ["-s", mainPkg, link]);
  }
  return { mainPkg, repo, wt, link };
}

const sentinelOk = (mainPkg) => existsSync(mainPkg) && readdirSync(mainPkg).length === 2;
const linkExists = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Copy the agent-wt dir so a scenario can break/replace one tool without touching the real one. */
function copyLibDir(sb) {
  const dir = join(sb, "libcopy");
  mkdirSync(dir);
  for (const f of readdirSync(HERE)) {
    if (/\.(mjs|sh)$/.test(f) && !/\.test\./.test(f)) copyFileSync(join(HERE, f), join(dir, f));
  }
  return dir;
}

const REMOVE = 'set -euo pipefail; cd "$1"; . "$2"; maple_remove_worktree "$3"';

/** Run maple_remove_worktree from libDir with no plugin root / cache / repo plugin/ to fall back on. */
function removeIsolated(libDir, { repo, wt }, sb) {
  const home = join(sb, "home");
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_PLUGIN_ROOT;
  delete env.MAPLE_MAIN_ROOT;
  return sh(
    "bash",
    ["-c", REMOVE, "bash", posixish(repo), posixish(join(libDir, "maple-lib.sh")), posixish(wt)],
    { env },
  );
}

function inSandbox(fn) {
  const sb = mkdtempSync(join(tmpdir(), "maple-junction-"));
  try {
    fn(sb, scenario(sb));
  } finally {
    rmSync(sb, { recursive: true, force: true });
  }
}

// (c) normal path: the real lib.
inSandbox((sb, sc) => {
  const r = sh("bash", [
    "-c",
    REMOVE,
    "bash",
    posixish(sc.repo),
    posixish(join(HERE, "maple-lib.sh")),
    posixish(sc.wt),
  ]);
  check(
    "(c) maple_remove_worktree completed",
    r.status === 0,
    r.status === 0 ? "" : String(r.stderr).trim().split("\n").slice(-2).join(" | "),
  );
  const survivors = existsSync(sc.mainPkg) ? readdirSync(sc.mainPkg) : null;
  check(
    "(c) link TARGET's real files survive the teardown",
    survivors !== null && survivors.length === 2,
    `main/pkg = ${survivors === null ? "DIR GONE" : survivors.join(",") || "EMPTY (gutted!)"}`,
  );
  check("(c) worktree dir is gone", !existsSync(sc.wt));
});

// (a) strip tool missing (plugin cache updated mid-run): refuse loudly, delete NOTHING.
inSandbox((sb, sc) => {
  const libDir = copyLibDir(sb);
  rmSync(join(libDir, "strip-links.mjs"));
  const r = removeIsolated(libDir, sc, sb);
  check("(a) missing strip tool -> non-zero exit", r.status !== 0, `status ${r.status}`);
  check("(a) loud error printed", /NOT removing/.test(String(r.stderr)), String(r.stderr).trim().slice(-160));
  check("(a) worktree and link untouched", existsSync(sc.wt) && linkExists(sc.link));
  check("(a) sentinel behind the link survives", sentinelOk(sc.mainPkg));
});

// (b) a strip that exits 0 but leaves the link: the independent re-scan must refuse.
inSandbox((sb, sc) => {
  const libDir = copyLibDir(sb);
  writeFileSync(join(libDir, "strip-links.mjs"), "process.exit(0);\n");
  const r = removeIsolated(libDir, sc, sb);
  check("(b) link survives a no-op strip -> non-zero exit", r.status !== 0, `status ${r.status}`);
  check("(b) loud error printed", /links remain/.test(String(r.stderr)), String(r.stderr).trim().slice(-160));
  check("(b) worktree and link untouched", existsSync(sc.wt) && linkExists(sc.link));
  check("(b) sentinel behind the link survives", sentinelOk(sc.mainPkg));
});

if (failed > 0) {
  console.error(`${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("junction-safety: all assertions passed.");
