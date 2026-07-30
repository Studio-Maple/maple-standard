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
 * Shape: main/pkg holds real files; a git worktree carries
 * `.next/node_modules/<link>` targeting main/pkg (junction on Windows,
 * symlink on POSIX); maple_remove_worktree runs; main/pkg files must
 * SURVIVE and the worktree must be gone. On POSIX every deleter unlinks
 * symlinks safely, so the test passes trivially there — the regression it
 * pins down is Windows-specific, and runs for real on Windows dev machines.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
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

const sb = mkdtempSync(join(tmpdir(), "maple-junction-"));
try {
  // The "main checkout" stand-in: a real package dir with real files.
  const mainPkg = join(sb, "main", "pkg");
  mkdirSync(mainPkg, { recursive: true });
  writeFileSync(join(mainPkg, "a.js"), "real file A\n");
  writeFileSync(join(mainPkg, "b.js"), "real file B\n");

  // A tiny repo + one agent worktree.
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

  // Run the real maple_remove_worktree from the real lib.
  const lib = posixish(join(HERE, "maple-lib.sh"));
  const script = 'set -euo pipefail; cd "$1"; . "$2"; maple_remove_worktree "$3"';
  const r = sh("bash", ["-c", script, "bash", posixish(repo), lib, posixish(wt)]);
  check(
    "maple_remove_worktree completed",
    r.status === 0,
    r.status === 0 ? "" : String(r.stderr).trim().split("\n").slice(-2).join(" | "),
  );

  const survivors = existsSync(mainPkg) ? readdirSync(mainPkg) : null;
  check(
    "link TARGET's real files survive the teardown",
    survivors !== null && survivors.length === 2,
    `main/pkg = ${survivors === null ? "DIR GONE" : survivors.join(",") || "EMPTY (gutted!)"}`,
  );
  check("worktree dir is gone", !existsSync(wt));
} finally {
  rmSync(sb, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("junction-safety: all assertions passed.");
