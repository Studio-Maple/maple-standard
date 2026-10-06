#!/usr/bin/env node
// Thin delegate — the canonical implementation lives in plugin/scripts/deps/check-dep-freshness.mjs
// (D064), bundled into the maple-standard plugin so adopting projects get the same gate. This wrapper
// keeps `node scripts/check-dep-freshness.mjs` / the ci:fast wiring working against THIS repo's root
// regardless of invocation cwd. Same pattern as scripts/check-docs-drift.mjs.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { run } from "../plugin/scripts/deps/check-dep-freshness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const bi = process.argv.indexOf("--base"); // heavy tier: everything changed since the last green heavy run (D066)
const { errors, lines } = await run({ root: ROOT, base: bi > 0 ? process.argv[bi + 1] : undefined });
for (const l of lines) {
  if (l.startsWith("[error]")) console.error(l);
  else console.log(l);
}
process.exit(errors > 0 ? 1 : 0);
