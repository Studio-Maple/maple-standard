#!/usr/bin/env node
/**
 * guards.test.mjs — fixture-driven contract tests for every guard module behind plugin/hooks/guard.mjs (D065).
 * Each fixtures/<guard>.json is an array of suites: { setup, cases }. A case is a tool call plus the verdict
 * the dispatcher must reach for it (allow | deny | ask | warn) and an optional message regex.
 *   setup.config  maple.config.json written into a fresh temp project (omit for none)
 *   setup.git     true -> `git init` + one commit in the project
 *   setup.linked  ["w1"] -> real linked worktrees created at .worktrees/<name>
 *   setup.files   { "package.json": "..." } extra files
 * Strings in a case may use {ROOT} (the temp project, forward slashes). Plain node, exits non-zero on failure:
 *   node plugin/scripts/hooks/guards.test.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { evaluate } = await import(pathToFileURL(join(HERE, "..", "..", "hooks", "guard.mjs")).href);

const fwd = (p) => p.replace(/\\/g, "/");
const sub = (v, root) => (typeof v === "string" ? v.replaceAll("{ROOT}", root) : Array.isArray(v) ? v.map((x) => sub(x, root)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x, root)])) : v);
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

function makeProject(setup = {}) {
  const root = fwd(realpathSync.native(mkdtempSync(join(tmpdir(), "guards-"))));
  if (setup.config) writeFileSync(join(root, "maple.config.json"), JSON.stringify(setup.config, null, 2));
  for (const [f, content] of Object.entries(setup.files ?? {})) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), content);
  }
  if (setup.git || setup.linked) {
    git(root, "init", "-q", "-b", "main");
    git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    for (const w of setup.linked ?? []) git(root, "worktree", "add", "-q", `.worktrees/${w}`, "-b", `agent/${w}`);
  }
  return root;
}

const verdictOf = (res) => (res.deny ? "deny" : res.ask ? "ask" : res.warns.length ? "warn" : "allow");

let failed = 0;
let total = 0;
const dir = join(HERE, "fixtures");
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const suites = JSON.parse(readFileSync(join(dir, file), "utf8"));
  console.log(`\n=== ${file} ===`);
  for (const suite of suites) {
    const root = makeProject(suite.setup);
    try {
      for (const c of suite.cases) {
        total++;
        const cwd = sub(c.cwd ?? "{ROOT}", root);
        const input = sub(c.input, root);
        const res = await evaluate({ tool_name: c.tool ?? "Bash", cwd, tool_input: input });
        const got = verdictOf(res);
        const text = res.deny || res.ask || res.warns.join("\n");
        const okVerdict = got === c.expect;
        const okMatch = !c.match || new RegExp(c.match, "i").test(text);
        const label = `${c.tool ?? "Bash"} ${c.name ?? JSON.stringify(input).slice(0, 80)}`;
        if (okVerdict && okMatch) console.log(`  PASS  ${c.expect.padEnd(5)} ${label}`);
        else { failed++; console.log(`  FAIL  want ${c.expect}${c.match ? ` /${c.match}/` : ""}, got ${got} — ${label}\n        ${text.slice(0, 240)}`); }
      }
    } finally {
      for (const w of suite.setup?.linked ?? []) git(root, "worktree", "remove", "--force", `.worktrees/${w}`);
      rmSync(root, { recursive: true, force: true });
    }
  }
}
console.log(`\n${total - failed}/${total} guard cases passed`);
process.exit(failed ? 1 : 0);
