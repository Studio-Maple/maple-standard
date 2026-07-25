#!/usr/bin/env node
// Thin delegate — the canonical implementation lives in
// plugin/scripts/docs/next-task-id.mjs, bundled into the maple-standard
// plugin (its /sync-docs command and ask-gate hook depend on it too). See
// docs/decisions.md D010, docs/tasks.md #T13.
//
// This wrapper exists so `node scripts/next-task-id.mjs` / `pnpm next-id`
// keep working unchanged for this template repo, resolved against ITS OWN
// root regardless of invocation cwd. Re-exports everything for any
// programmatic/test usage.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export * from "../plugin/scripts/docs/next-task-id.mjs";
import { run } from "../plugin/scripts/docs/next-task-id.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function isMain() {
  if (!process.argv[1]) return false;
  const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;
  return import.meta.url === argvUrl;
}

async function main() {
  let result;
  try {
    result = await run(process.argv.slice(2), { root: ROOT });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  if (result.stdout) process.stdout.write(result.stdout + "\n");
  if (result.stderr) process.stderr.write(result.stderr + "\n");
  process.exit(result.exitCode);
}

if (isMain()) {
  await main();
}
