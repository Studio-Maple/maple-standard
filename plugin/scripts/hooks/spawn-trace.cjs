// Preload (node --require) for dispatcher.test.mjs: records every child-process spawn the process makes to
// $SPAWN_TRACE_FILE, so a test can prove a code path starts no child. Patches the public child_process API
// and re-syncs the ESM named exports so `import { spawnSync } from "node:child_process"` sees the patch.
const cp = require("node:child_process");
const { appendFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const file = process.env.SPAWN_TRACE_FILE;
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = cp[name];
  cp[name] = function traced(...args) {
    if (file) appendFileSync(file, `${name} ${String(args[0])}\n`);
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
