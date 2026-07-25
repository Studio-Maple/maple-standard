#!/usr/bin/env node
// Thin delegate — the canonical implementation lives in
// plugin/scripts/docs/doc-search/search.mjs, bundled into the
// maple-standard plugin (the ask-gate hook's optional BM25 signal depends
// on this doc-search shape too). See docs/decisions.md D010,
// docs/tasks.md #T13.
//
// Re-exports everything so `import` callers (e.g. plugin/hooks/ask-gate.mjs
// via its configured docs.searchScript) keep working unchanged, and runs
// the CLI (`node scripts/doc-search/search.mjs "query"` / `pnpm
// docs:search`) against THIS template repo's own root regardless of
// invocation cwd.
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export * from "../../plugin/scripts/docs/doc-search/search.mjs";
import { search, buildIndex, chunkDocs } from "../../plugin/scripts/docs/doc-search/search.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const kIdx = args.indexOf("-k");
  const k = kIdx !== -1 ? Number(args[kIdx + 1]) || 6 : 6;
  const json = args.includes("--json");
  const query = args.filter((a, i) => a !== "--json" && a !== "-k" && i !== kIdx + 1).join(" ");
  if (!query) {
    console.error('usage: node scripts/doc-search/search.mjs "your question" [-k 6] [--json]');
    process.exit(2);
  }
  const t0 = performance.now();
  const results = search(query, k, buildIndex(chunkDocs(ROOT)));
  const ms = Math.round(performance.now() - t0);
  if (json) {
    console.log(JSON.stringify({ query, ms, results }, null, 1));
  } else {
    console.log(`"${query}" — top ${results.length} (${ms}ms)\n`);
    for (const r of results) {
      console.log(`[${r.score}] ${r.anchor}  §${r.heading_trail.join(" › ")}`);
      console.log(`    ${r.text.replace(/\s+/g, " ").slice(0, 160)}…\n`);
    }
  }
}
