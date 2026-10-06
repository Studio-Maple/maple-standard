// scripts/ci-local.sh front door (D066): the tiers are fast | gate | heavy (core/full are gone) and an unlisted MAPLE_GATE_SKIP
// reason fails before any check runs. These cases exit in milliseconds - nothing heavy is started.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findBash, toPosix } from "./find-bash.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(ROOT, "scripts", "ci-local.sh");
let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };

if (!existsSync(SCRIPT)) {
  console.log("(skipped - no scripts/ci-local.sh in this checkout)");
  process.exit(0);
}
const bash = findBash();
const run = (args, env = {}) => spawnSync(bash, [toPosix(SCRIPT), ...args], {
  cwd: ROOT, encoding: "utf8", env: { ...process.env, CI_PREPUSH: "", ...env }, timeout: 60000,
});

t("an unknown tier is refused (core and full no longer exist)", () => {
  for (const tier of ["core", "full", "nope"]) {
    const r = run([tier]);
    assert.notEqual(r.status, 0, tier);
    assert.match(r.stderr, /Unknown tier .* Use: fast \| gate \| heavy/);
  }
});

t("an unlisted MAPLE_GATE_SKIP reason fails before any work", () => {
  const r = run(["fast"], { MAPLE_GATE_SKIP: "because-i-said-so" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown MAPLE_GATE_SKIP reason 'because-i-said-so'/);
  assert.match(r.stderr, /Allowed: docker-unavailable, registry-unreachable/);
  assert.ok(!/--- fast 1\/7/.test(r.stdout), "no check may have started");
});

t("a bare '1' is not a reason either", () => {
  const r = run(["gate"], { MAPLE_GATE_SKIP: "1" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown MAPLE_GATE_SKIP reason '1'/);
});

console.log(`\nall ${n} ci-local front-door tests passed`);
