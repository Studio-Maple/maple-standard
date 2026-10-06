#!/usr/bin/env node
// Thin delegate — the canonical implementation lives in
// plugin/scripts/docs/doc-search/search.mjs, bundled into the
// maple-standard plugin. See docs/decisions.md D010,
// docs/tasks.md #T13.
//
// Re-exports everything so `import` callers (library callers) keep working unchanged, and runs
// the CLI (`node scripts/doc-search/search.mjs "query"` / `pnpm
// docs:search`) against THIS template repo's own root regardless of
// invocation cwd.
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export * from "../../plugin/scripts/docs/doc-search/search.mjs";
// MJ-6: delegate to the plugin's own CLI parser instead of carrying a
// second copy — the previous copy here had the same argv-parsing bug
// (dropped the first word of a query with no `-k` flag) as the plugin
// original, because a fix to one didn't reach the other.
import { runCli } from "../../plugin/scripts/docs/doc-search/search.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), ROOT);
}
