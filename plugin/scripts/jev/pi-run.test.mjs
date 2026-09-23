#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { piAvailable, assertPiWorktree, runPi, parseCliArgs } from "./pi-run.mjs";
import { DEFAULT_PI_MODEL } from "./ladder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "pi-run.mjs");

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

    let threwBadModel = null;
    try {
      // Pi unavailability is checked first, so this exercises the default-model
      // plumbing rather than the isPiModel() guard directly — see the CLI-arg
      // checks below for that guard's own coverage via parseCliArgs().
      await runPi({ root, task: "x", prompt: "x", model: "sonnet" });
    } catch (err) {
      threwBadModel = err;
    }
    check("runPi() with a non-Pi model still fails closed (Pi unavailable) rather than silently succeeding", threwBadModel?.piUnavailable === true);
  } else {
    console.log("  SKIP  runPi() unavailability path — Pi SDK is installed in this environment");
  }

  // --- CLI arg parsing (pure — no Pi SDK needed) ---
  {
    const args = parseCliArgs(["--task", "rename a helper", "--prompt", "do the thing"]);
    check("defaults --model to gpt-5.6-luna when omitted", args.model === DEFAULT_PI_MODEL, JSON.stringify(args));
    check("reads --task and --prompt", args.task === "rename a helper" && args.prompt === "do the thing");
  }
  {
    const args = parseCliArgs(["--model", "gpt-5.6-terra", "--task", "x", "--prompt", "y"]);
    check("--model overrides the default", args.model === "gpt-5.6-terra", JSON.stringify(args));
  }
  {
    const args = parseCliArgs([]);
    check("no args at all still returns a well-formed object", args.model === DEFAULT_PI_MODEL && args.task === "" && args.prompt === "");
  }

  // --- CLI process behavior: usage error when task/prompt are missing ---
  {
    const r = spawnSync(process.execPath, [CLI], { input: "", encoding: "utf8", timeout: 15_000 });
    check("CLI exits non-zero with a usage message when task/prompt are missing", r.status !== 0 && /usage:/.test(r.stderr), `status=${r.status} stderr=${r.stderr}`);
  }
}

run().then(() => {
  if (failed > 0) {
    console.error(`${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log("All pi-run.mjs checks passed.");
});
