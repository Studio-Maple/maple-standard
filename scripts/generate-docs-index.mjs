#!/usr/bin/env node
// Thin delegate — the canonical implementation lives in
// plugin/scripts/docs/generate-docs-index.mjs, bundled into the
// maple-standard plugin so non-template adopters get this generator too.
// See docs/decisions.md D010, docs/tasks.md #T13.
//
// This wrapper exists so `node scripts/generate-docs-index.mjs` / `pnpm
// docs:index` keep working unchanged for this template repo, resolved
// against ITS OWN root regardless of invocation cwd.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run } from "../plugin/scripts/docs/generate-docs-index.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const { entries, catalogResult, docsIndexJson, indexPath } = await run({ root: ROOT });
console.log(`Wrote ${entries.length} entries to ${docsIndexJson}`);
console.log(`Catalog (${indexPath}): ${catalogResult}`);
const missing = entries.filter((e) => !e.audience);
if (missing.length > 0) {
  console.warn(`\n${missing.length} files missing an audience (frontmatter \`audience\` or legacy preamble \`**Audience:**\`):`);
  for (const m of missing) console.warn(`  ${m.path}`);
}
