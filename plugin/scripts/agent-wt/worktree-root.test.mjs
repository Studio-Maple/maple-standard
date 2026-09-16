#!/usr/bin/env node
/**
 * worktree-root.test.mjs — regression test for the sibling-`-wt`-dir ->
 * in-repo-`.worktrees` default change.
 *
 * Covers two things maple-lib.sh must keep true:
 *   1. `_maple_default_wt_root()` resolves to `<repo>/.worktrees` when
 *      `worktrees.root` isn't configured (the new default — it used to be
 *      a SIBLING `<repo>-wt` directory).
 *   2. `maple_ensure_gitignored <entry>` — the generic helper
 *      `maple_ensure_loop_state_gitignored` was refactored out of — stays
 *      idempotent, tolerates a CRLF-terminated .gitignore, and fixes up a
 *      missing trailing newline before appending. These are hard-won
 *      correctness fixes (reproduced bugs, not hypotheticals); this test
 *      exists so refactoring the shared logic can't silently regress them
 *      for an entry other than `.loop-state/`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const posixish = (p) => p.replaceAll("\\", "/");

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...opts });
}

if (sh("bash", ["-c", "echo ok"]).status !== 0) {
  console.log("SKIP: bash not on PATH — the agent-wt scripts (and this test) need it.");
  process.exit(0);
}

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const lib = posixish(join(HERE, "maple-lib.sh"));
const sb = mkdtempSync(join(tmpdir(), "maple-wtroot-"));

try {
  // ── 1. default root resolves to <repo>/.worktrees, not a sibling dir ──────
  {
    const repo = join(sb, "repo-default");
    mkdirSync(repo, { recursive: true });
    sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
    sh(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
      { cwd: repo },
    );
    // Source the lib (which computes MAPLE_WT_ROOT at source time) and echo
    // it. Compare only the RELATIVE suffix — bash/git-bash prints
    // MAPLE_MAIN_ROOT in its own MSYS-translated POSIX form (e.g.
    // "/tmp/...") which need not match Node's own (Windows-form) path
    // string for the same directory, so a full-path comparison would be
    // comparing apples to oranges here. The point of this test is the
    // *shape* of the resolved root (inside the repo, "<repo>/.worktrees"),
    // not byte-identical path strings.
    const r = sh("bash", ["-c", 'cd "$1"; . "$2"; printf "%s" "$MAPLE_WT_ROOT"', "bash", posixish(repo), lib]);
    const got = posixish(String(r.stdout || "").trim()).toLowerCase();
    check(
      "default worktrees.root resolves inside the repo (.worktrees), not a sibling -wt dir",
      r.status === 0 && got.endsWith("/repo-default/.worktrees"),
      `got=${got || "(empty, stderr: " + String(r.stderr).trim().slice(-200) + ")"}`,
    );
    check("default root is NOT the old sibling <repo>-wt form", !got.includes("repo-default-wt"), `got=${got}`);
  }

  // ── 2. worktrees.root config override still works (repo-relative) ─────────
  {
    const repo = join(sb, "repo-cfg");
    mkdirSync(repo, { recursive: true });
    sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
    sh(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"],
      { cwd: repo },
    );
    writeFileSync(
      join(repo, "maple.config.json"),
      JSON.stringify({ project: { name: "x", slug: "x" }, worktrees: { root: "custom-wt-dir" } }),
    );
    const r = sh("bash", ["-c", 'cd "$1"; . "$2"; printf "%s" "$MAPLE_WT_ROOT"', "bash", posixish(repo), lib]);
    const got = posixish(String(r.stdout || "").trim()).toLowerCase();
    check(
      "worktrees.root config override (repo-relative) still resolves correctly",
      r.status === 0 && got.endsWith("/repo-cfg/custom-wt-dir"),
      `got=${got}`,
    );
  }

  // ── 3. maple_ensure_gitignored: fresh append ───────────────────────────────
  {
    const repo = join(sb, "gi-fresh");
    mkdirSync(repo, { recursive: true });
    sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
    sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "config", "core.autocrlf", "false"], { cwd: repo });
    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    sh("git", ["add", "."], { cwd: repo });
    sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo });

    const script = 'set -euo pipefail; cd "$1"; . "$2"; maple_ensure_gitignored ".worktrees/"';
    const r = sh("bash", ["-c", script, "bash", posixish(repo), lib]);
    const gi = readFileSync(join(repo, ".gitignore"), "utf8");
    check("maple_ensure_gitignored appends the entry", r.status === 0 && /^\.worktrees\/$/m.test(gi), gi);
    check("maple_ensure_gitignored auto-commits .gitignore", sh("git", ["status", "--porcelain"], { cwd: repo }).stdout.trim() === "");
  }

  // ── 4. maple_ensure_gitignored: idempotent (no duplicate line) ─────────────
  {
    const repo = join(sb, "gi-idempotent");
    mkdirSync(repo, { recursive: true });
    sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, ".gitignore"), "node_modules\n.worktrees/\n");
    sh("git", ["add", "."], { cwd: repo });
    sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo });

    const script = 'set -euo pipefail; cd "$1"; . "$2"; maple_ensure_gitignored ".worktrees/"';
    sh("bash", ["-c", script, "bash", posixish(repo), lib]);
    const gi = readFileSync(join(repo, ".gitignore"), "utf8");
    const count = (gi.match(/\.worktrees\/?/g) || []).length;
    check("maple_ensure_gitignored is idempotent (no duplicate line)", count === 1, gi);
  }

  // ── 5. maple_ensure_gitignored: CRLF-terminated file already has the entry ─
  {
    const repo = join(sb, "gi-crlf");
    mkdirSync(repo, { recursive: true });
    sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, ".gitignore"), "node_modules\r\n.worktrees\r\n");
    sh("git", ["add", "."], { cwd: repo });
    sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo });

    const script = 'set -euo pipefail; cd "$1"; . "$2"; maple_ensure_gitignored ".worktrees/"';
    sh("bash", ["-c", script, "bash", posixish(repo), lib]);
    const gi = readFileSync(join(repo, ".gitignore"), "utf8");
    const count = (gi.match(/\.worktrees\/?\r?\n/g) || []).length;
    check(
      "maple_ensure_gitignored tolerates CRLF + no-slash form as already-present",
      count === 1,
      JSON.stringify(gi),
    );
  }

  // ── 6. maple_ensure_gitignored: missing trailing newline before append ────
  {
    const repo = join(sb, "gi-no-newline");
    mkdirSync(repo, { recursive: true });
    sh("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, ".gitignore"), "node_modules"); // no trailing \n
    sh("git", ["add", "."], { cwd: repo });
    sh("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: repo });

    const script = 'set -euo pipefail; cd "$1"; . "$2"; maple_ensure_gitignored ".worktrees/"';
    sh("bash", ["-c", script, "bash", posixish(repo), lib]);
    const gi = readFileSync(join(repo, ".gitignore"), "utf8");
    check(
      "maple_ensure_gitignored never glues onto an unterminated last line",
      gi.includes("node_modules\n") && !gi.includes("node_modules.worktrees"),
      JSON.stringify(gi),
    );
  }
} finally {
  rmSync(sb, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("worktree-root: all assertions passed.");
