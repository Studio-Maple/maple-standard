#!/usr/bin/env node
import { piAvailable, assertPiWorktree, runPi } from "./pi-run.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const throws = (name, fn) => {
  try {
    fn();
    check(name, false, "expected it to throw");
  } catch {
    check(name, true);
  }
};

async function run() {
  // This repo does not (and should not) depend on the Pi SDK — detect
  // "not installed" cleanly rather than throwing.
  const available = await piAvailable();
  check("piAvailable() resolves to a boolean without throwing", typeof available === "boolean", String(available));

  const root = process.platform === "win32" ? "C:\\repo" : "/repo";
  const sep = process.platform === "win32" ? "\\" : "/";
  const good = `${root}${sep}.worktrees${sep}pi-task-abc12345`;
  check("accepts a well-formed pi-run worktree path", assertPiWorktree(root, good) === good);

  throws("rejects a path outside .worktrees", () => assertPiWorktree(root, `${root}${sep}src`));
  throws("rejects a .worktrees entry without the pi- prefix", () => assertPiWorktree(root, `${root}${sep}.worktrees${sep}agent-jev-skills`));
  throws("rejects a nested path (not a direct child of .worktrees)", () => assertPiWorktree(root, `${root}${sep}.worktrees${sep}pi-x${sep}nested`));

  if (!available) {
    let threw = null;
    try {
      await runPi({ root, task: "x", prompt: "x" });
    } catch (err) {
      threw = err;
    }
    check("runPi() throws a clearly-flagged error when Pi isn't installed", threw?.piUnavailable === true, String(threw));
  } else {
    console.log("  SKIP  runPi() unavailability path — Pi SDK is installed in this environment");
  }
}

run().then(() => {
  if (failed > 0) {
    console.error(`${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All pi-run.mjs checks passed.");
});
