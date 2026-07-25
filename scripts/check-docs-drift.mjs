#!/usr/bin/env node
// Thin delegate — the canonical implementation lives in
// plugin/scripts/docs/check-docs-drift.mjs, bundled into the maple-standard
// plugin so non-template adopters (VeHagita, EasyCaller) get this gate too,
// instead of owning their own copy. See docs/decisions.md D010,
// docs/tasks.md #T13.
//
// This wrapper exists so `node scripts/check-docs-drift.mjs` / `pnpm
// docs:drift` / the husky/CI wiring keep working unchanged for this
// template repo, resolved against ITS OWN root regardless of invocation cwd.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run } from "../plugin/scripts/docs/check-docs-drift.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fix = process.argv.includes("--fix");

const { errors, messages } = await run({ root: ROOT, fix });
for (const m of messages) {
  if (m.startsWith("[error]")) console.error(m);
  else if (m.startsWith("[warn]")) console.warn(m);
  else console.log(m);
}
process.exit(errors > 0 ? 1 : 0);
