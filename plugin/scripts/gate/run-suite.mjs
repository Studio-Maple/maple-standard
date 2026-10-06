/**
 * run-suite.mjs - the shared test-file runner behind every plugin/scripts/<suite>/run-tests.mjs (D066).
 *
 * A suite's files split into two sets by NAME:
 *   *.test.mjs / *.test.sh              unit set: hermetic, fast. Runs in `fast` and `gate`.
 *   *.integration.test.mjs / .sh        integration set: real Docker/network/scanners or minutes of
 *                                       git/worktree work. Runs only in the `heavy` tier.
 *
 *   run-tests.mjs                 unit set
 *   run-tests.mjs --integration   integration set
 *   run-tests.mjs --all           both
 *
 * Files are plain scripts that exit non-zero on failure (the repo's standalone test style).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const isIntegration = (f) => /\.integration\.test\.(mjs|sh)$/.test(f);

/** @returns {"unit"|"integration"|"all"} */
export function modeFromArgv(argv) {
  if (argv.includes("--all")) return "all";
  if (argv.includes("--integration")) return "integration";
  return "unit";
}

/** Runner binary for a test file: node for .mjs, Git Bash/bash for .sh. */
function launcher(file) {
  return file.endsWith(".sh") ? ["bash", [file]] : [process.execPath, [file]];
}

/**
 * @param {{dir:string, label:string, argv?:string[], extra?:string[]}} o
 *   extra: absolute paths of test files that live outside `dir` (always unit unless named integration)
 * @returns {number} process exit code
 */
export function runSuite({ dir, label, argv = process.argv.slice(2), extra = [] }) {
  const mode = modeFromArgv(argv);
  const own = readdirSync(dir).filter((f) => /\.test\.(mjs|sh)$/.test(f)).sort().map((f) => join(dir, f));
  const files = [...own, ...extra.filter((f) => existsSync(f))].filter((f) => {
    const integ = isIntegration(f);
    return mode === "all" || (mode === "integration" ? integ : !integ);
  });
  if (files.length === 0) {
    console.log(`No ${mode} test files in ${label} - nothing to run.`);
    return 0;
  }
  let failed = 0;
  for (const f of files) {
    console.log(`\n=== ${f.split(/[\\/]/).slice(-2).join("/")} ===`);
    const [cmd, args] = launcher(f);
    if (spawnSync(cmd, args, { stdio: "inherit" }).status !== 0) failed++;
  }
  if (failed > 0) {
    console.error(`\n${failed}/${files.length} ${label} ${mode} test file(s) FAILED.`);
    return 1;
  }
  console.log(`\nAll ${files.length} ${label} ${mode} test file(s) passed.`);
  return 0;
}
