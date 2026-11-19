#!/usr/bin/env node
// Tests for dependency necessity (D086): ledger rules, overlap listing, the package.json-edit path, the ci:fast
// ledger gate, and the warn/enforce behaviour of both new controls through the real hook dispatcher.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check as depVersionCheck } from "../../hooks/guards/dep-version-guard.mjs";
import { cacheSet } from "./cache.mjs";
import { checkAdds } from "./add-guard.mjs";
import { entryProblems, isWeak, staleEntries } from "./ledger.mjs";
import { ledgerGate } from "./ledger-gate.mjs";
import { findOverlap } from "./overlap.mjs";
import { checkNecessity } from "./necessity.mjs";

delete process.env.npm_config_registry;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed++;
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, "..", "..", "hooks", "guard.mjs");
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };
const write = (root, rel, content) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), typeof content === "string" ? content : JSON.stringify(content, null, 2));
};
const GOOD = { why: "Typed HTTP client with retries we need for the billing API", existing: "global fetch has no retry or interceptor support for this", alternative: "got was considered but is ESM-only and heavier here" };
const ledger = (entries) => ({ version: 1, entries });

try {
  console.log("ledger rules");
  for (const bad of ["", "short", "TODO", "tbd", "n/a", "none", "...", "..................", "lorem ipsum dolor sit amet", "TODO: fill this in later", "aaaaaaaaaaaaaaaaaaaa", "needed"]) {
    check(`weak: ${JSON.stringify(bad)}`, isWeak(bad));
  }
  check("a real sentence is fine", !isWeak("global fetch lacks retry/backoff for this API"));
  check("non-string is weak", isWeak(undefined) && isWeak(42));
  eq("no entry", entryProblems(null, false), ["no entry"]);
  eq("runtime needs all three", entryProblems({ why: GOOD.why }, false).length, 2);
  eq("dev needs only why", entryProblems({ why: GOOD.why }, true), []);
  eq("complete runtime entry", entryProblems(GOOD, false), []);
  eq("placeholder field named", entryProblems({ ...GOOD, existing: "TODO" }, false), [`"existing" is too short or placeholder text`]);
  eq("stale entries", staleEntries({ gone: {}, Kept_Pkg: {} }, new Set(["kept-pkg"])), ["gone"]);

  console.log("overlap map");
  const have = new Set(["node-fetch", "react", "zod", "recharts"]);
  const ov = findOverlap("axios", "npm", have);
  check("axios overlaps node-fetch (http-client) with the platform alternative", ov.groups[0]?.group === "http-client" && ov.groups[0].existing.includes("node-fetch") && ov.groups[0].platform.includes("fetch"), JSON.stringify(ov));
  eq("name in a group with no member present still names the platform alternative", findOverlap("dayjs", "npm", have).groups[0]?.platform.includes("Intl"), true);
  eq("unrelated package: no overlap", findOverlap("sharp", "npm", have), { groups: [], stems: [] });
  eq("shared name stem with an existing dependency", findOverlap("recharts-theme", "npm", have).stems, [{ name: "recharts", token: "recharts" }]);
  eq("python group", findOverlap("httpx", "PyPI", new Set(["requests"])).groups[0]?.existing, ["requests"]);
  eq("ecosystems do not mix", findOverlap("requests", "npm", new Set(["axios"])).groups, []);
  const groups = JSON.parse((await import("node:fs")).readFileSync(join(HERE, "data", "capabilities.json"), "utf8")).groups;
  check("capability map has about 30+ groups", Object.keys(groups).length >= 30, String(Object.keys(groups).length));

  console.log("necessity check (install-command path)");
  const root = tmp("nec-");
  write(root, "package.json", { dependencies: { "node-fetch": "^3.0.0", react: "^19.0.0" }, devDependencies: { vitest: "^4.0.0" } });
  const add = (name, dev = false, extra = {}) => ({ eco: "npm", name, dev, manifest: true, ...extra });
  let n = checkNecessity([add("axios")], root);
  check("missing entry -> message with D086, JSON shape, existing deps, overlap", n.message !== null && n.message.includes("D086") && n.message.includes('"why"') && n.message.includes('"alternative"') && n.message.includes("node-fetch, react") && n.message.includes("vitest") && n.message.includes("Overlap: axios does the same job as node-fetch"), n.message ?? "");
  eq("names the missing package", n.missing, ["axios"]);
  check("tells the agent the file does not exist yet", n.message.includes("does not exist yet"));
  eq("an existing dependency is not new", checkNecessity([add("react")], root).message, null);
  eq("global installs are not project dependencies", checkNecessity([add("axios", false, { global: true })], root).message, null);
  write(root, "deps-ledger.json", ledger({ axios: { why: GOOD.why } }));
  n = checkNecessity([add("axios")], root);
  check("runtime entry with only `why` is incomplete", n.message?.includes('"existing" is missing') && n.message.includes('"alternative" is missing'), n.message ?? "");
  write(root, "deps-ledger.json", ledger({ axios: { ...GOOD, existing: "TODO" } }));
  check("placeholder text is incomplete", checkNecessity([add("axios")], root).message?.includes('"existing" is too short or placeholder text') === true);
  eq("dev-only add needs only why", (write(root, "deps-ledger.json", ledger({ prettier: { why: "Formatter for the repo, pinned in CI" } })), checkNecessity([add("prettier", true)], root).message), null);
  check("the same entry is not enough for a runtime add", checkNecessity([add("prettier", false)], root).message !== null);
  write(root, "deps-ledger.json", ledger({ axios: GOOD }));
  eq("complete entry passes", checkNecessity([add("axios")], root).message, null);
  write(root, "deps-ledger.json", "{ not json");
  check("a broken ledger is reported, not ignored", checkNecessity([add("axios")], root).message?.includes("not valid JSON") === true);
  rmSync(join(root, "deps-ledger.json"));

  const py = tmp("nec-py-");
  eq("ad-hoc pip install with no Python manifest is skipped", checkNecessity([{ eco: "PyPI", name: "requests", dev: false, manifest: false }], py).message, null);
  write(py, "pyproject.toml", '[project]\nname = "x"\ndependencies = ["flask>=3"]\n');
  check("pip install in a Python project needs an entry", checkNecessity([{ eco: "PyPI", name: "requests", dev: false, manifest: false }], py).message?.includes("flask") === true);
  eq("uv add of an existing dependency is not new", checkNecessity([{ eco: "PyPI", name: "flask", dev: false, manifest: true }], py).message, null);
  check("python overlap named", checkNecessity([{ eco: "PyPI", name: "django", dev: false, manifest: true }], py).message?.includes("Overlap:") === true);

  const viaCmd = await checkAdds("cd /x && pnpm add axios -D", root, { packageAdd: false });
  check("checkAdds: -D add is dev (only `why` needed -> still missing here, no ledger)", viaCmd.necessity.deny?.includes("(dev)") === true);

  console.log("package.json edit path (dep-version-guard)");
  const proj = tmp("nec-edit-");
  const pkgText = JSON.stringify({ name: "x", dependencies: { react: "^19.0.0" }, devDependencies: {} }, null, 2);
  write(proj, "package.json", pkgText);
  const ctxFor = (input, cfg = {}) => ({ tool: "Edit", input, cwd: proj, config: () => ({ root: proj, cfg }) });
  const edit = (newBlock) => ({ file_path: join(proj, "package.json"), old_string: '"react": "^19.0.0"', new_string: `"react": "^19.0.0",\n    ${newBlock}` });
  let r = depVersionCheck(ctxFor(edit('"zod": "^3.0.0"')));
  check("a hand-written registry version is still the D064 denial", r?.deny?.includes("D064") === true);
  r = depVersionCheck(ctxFor(edit('"left": "latest"')));
  check("a tag spec passes D064 but warns on necessity in warn mode (default)", r?.warn?.includes("D086") === true && r.warn.includes("warn mode"), JSON.stringify(r));
  r = depVersionCheck(ctxFor(edit('"left": "latest"'), { security: { controls: { necessity: "enforce" } } }));
  check("enforce mode denies", r?.deny?.includes("D086") === true && r.deny.includes("react"), JSON.stringify(r));
  r = depVersionCheck(ctxFor(edit('"left": "latest"'), { security: { controls: { necessity: "off" } } }));
  eq("off mode is silent", r, undefined);
  eq("workspace-internal package needs no entry", depVersionCheck(ctxFor(edit('"@me/ui": "workspace:*"'), { security: { mode: "enforce" } })), undefined);
  write(proj, "deps-ledger.json", ledger({ left: GOOD }));
  eq("complete ledger entry passes", depVersionCheck(ctxFor(edit('"left": "latest"'), { security: { mode: "enforce" } })), undefined);
  rmSync(join(proj, "deps-ledger.json"));
  const devEdit = { file_path: join(proj, "package.json"), old_string: '"devDependencies": {}', new_string: '"devDependencies": { "tool": "latest" }' };
  write(proj, "deps-ledger.json", ledger({ tool: { why: "Build helper used by the release script" } }));
  eq("devDependencies add needs only why", depVersionCheck(ctxFor(devEdit, { security: { mode: "enforce" } })), undefined);
  eq("a version bump of an existing key is not a new dependency", depVersionCheck(ctxFor({ file_path: join(proj, "package.json"), old_string: '"^19.0.0"', new_string: '"latest"' }, { security: { mode: "enforce" } })), undefined);

  console.log("ci:fast ledger gate");
  const g = tmp("nec-gate-");
  write(g, "package.json", { dependencies: { react: "^19.0.0", newdep: "^1.0.0" }, devDependencies: { devtool: "^2.0.0" } });
  const baseTree = { "package.json": JSON.stringify({ dependencies: { react: "^19.0.0" } }) };
  const git = (_root, args) => (args[0] === "ls-tree" ? Object.keys(baseTree).join("\n") : args[0] === "show" ? baseTree[args[1].split(":./")[1]] : "");
  write(g, "maple.config.json", { security: { controls: { necessity: "enforce" } } });
  let gate = ledgerGate({ root: g, base: "abc", git });
  check("enforce: new deps without entries FAIL the gate", gate.errors === 2 && gate.lines.some((l) => l.startsWith("[error]") && l.includes("newdep")) && gate.lines.some((l) => l.includes("devtool") && l.includes("(dev)")), gate.lines.join(" | "));
  write(g, "deps-ledger.json", ledger({ newdep: GOOD, devtool: { why: "Linter we run in CI for the repo" }, removed: GOOD }));
  gate = ledgerGate({ root: g, base: "abc", git });
  check("complete entries pass; an entry for a removed package warns", gate.errors === 0 && gate.lines.some((l) => l.startsWith("[warn]") && l.includes('"removed"')), gate.lines.join(" | "));
  write(g, "maple.config.json", { security: { controls: { necessity: "warn" } } });
  rmSync(join(g, "deps-ledger.json"));
  gate = ledgerGate({ root: g, base: "abc", git });
  check("warn mode: a warning instead of a failure", gate.errors === 0 && gate.lines.filter((l) => l.startsWith("[warn]")).length === 2 && gate.lines.some((l) => l.includes("warn mode")), gate.lines.join(" | "));
  write(g, "maple.config.json", { security: { controls: { necessity: "off" } } });
  eq("off: nothing", ledgerGate({ root: g, base: "abc", git }), { errors: 0, lines: [] });
  write(g, "maple.config.json", { security: { mode: "enforce" } });
  write(g, "pyproject.toml", '[project]\nname="x"\ndependencies=["requests>=2"]\n');
  gate = ledgerGate({ root: g, base: "abc", git });
  check("Python manifests count too", gate.lines.some((l) => l.includes("requests")), gate.lines.join(" | "));

  console.log("warn / enforce through the hook dispatcher");
  const hook = (cwd, command, env = {}) => spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command } }), encoding: "utf8", timeout: 25_000,
    env: { ...process.env, npm_config_registry: "http://127.0.0.1:9", ...env },
  });
  const h = tmp("nec-hook-");
  write(h, "package.json", { dependencies: { "node-fetch": "^3.0.0" } });
  const cmd = (c) => `cd "${h.replace(/\\/g, "/")}" && ${c}`;
  write(h, "maple.config.json", { security: { controls: { packageAdd: "off", necessity: "enforce" } } });
  let p = hook(h, cmd("pnpm add axios"));
  check("necessity enforce: pnpm add of an undocumented new dependency is denied", p.status === 2 && p.stderr.includes("D086") && p.stderr.includes("node-fetch"), p.stderr);
  write(h, "maple.config.json", { security: { controls: { packageAdd: "off", necessity: "warn" } } });
  p = hook(h, cmd("pnpm add axios"));
  check("necessity warn: allowed with a warn-mode notice", p.status === 0 && p.stderr.includes("warn mode") && p.stderr.includes("D086"), p.stderr);
  write(h, "maple.config.json", { security: { controls: { packageAdd: "off", necessity: "off" } } });
  p = hook(h, cmd("pnpm add axios"));
  check("necessity off: silent", p.status === 0 && !p.stderr.includes("D086"), p.stderr);
  write(h, "maple.config.json", { security: { controls: { packageAdd: "off", necessity: "enforce" } } });
  write(h, "deps-ledger.json", ledger({ axios: GOOD }));
  p = hook(h, cmd("pnpm add axios"));
  check("complete ledger entry -> allowed", p.status === 0 && !p.stderr.includes("D086"), p.stderr);
  p = hook(h, cmd("pnpm add node-fetch"));
  check("already-declared package -> allowed", p.status === 0);

  // packageAdd with a pre-seeded user cache (zero network): lodahs is a typosquat of lodash and has a vuln
  const cacheDir = tmp("nec-cache-");
  const day = 86_400_000;
  const iso = (d) => new Date(Date.now() - d * day).toISOString();
  cacheSet(cacheDir, "npm", "lodahs", { latest: "1.1.0", tags: { latest: "1.1.0" }, times: { "1.1.0": iso(90) }, created: iso(400), deprecated: {} });
  cacheSet(cacheDir, "npm-downloads", "lodahs", 40);
  cacheSet(cacheDir, "osv", "npm/lodahs@1.1.0", ["GHSA-test-0001"]);
  const env = { MAPLE_SECURITY_CACHE_DIR: cacheDir, npm_config_registry: "" };
  write(h, "deps-ledger.json", ledger({ lodahs: GOOD }));
  write(h, "maple.config.json", { security: { controls: { packageAdd: "enforce", necessity: "off" } } });
  p = hook(h, cmd("pnpm add lodahs"), env);
  check("packageAdd enforce: denied (osv + downloads + typosquat), warm cache = no network", p.status === 2 && p.stderr.includes("GHSA-test-0001") && p.stderr.includes("40 weekly downloads") && p.stderr.includes("typosquat"), p.stderr);
  write(h, "maple.config.json", { security: { controls: { packageAdd: "warn", necessity: "off" } } });
  p = hook(h, cmd("pnpm add lodahs"), env);
  check("packageAdd warn: the same findings become a warning", p.status === 0 && p.stderr.includes("warn mode") && p.stderr.includes("GHSA-test-0001"), p.stderr);
  write(h, "maple.config.json", { security: { controls: { packageAdd: "off", necessity: "off" } } });
  p = hook(h, cmd("pnpm add lodahs"), env);
  check("packageAdd off: silent", p.status === 0 && !p.stderr.includes("GHSA"), p.stderr);
  write(h, "maple.config.json", {});
  p = hook(h, cmd("pnpm add lodahs"), env);
  check("no security block: every control warns (D082)", p.status === 0 && p.stderr.includes("GHSA-test-0001"), p.stderr);
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
