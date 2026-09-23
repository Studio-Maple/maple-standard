#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const script = join(HERE, "task.mjs");
let failed = 0;
const check = (name, ok, detail = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); if (!ok) failed++; };
const run = (args, env) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { ...process.env, ...env, MAPLE_ID_SHARED: "0" } });
const base = mkdtempSync(join(tmpdir(), "maple-task-cli-"));
try {
  const repo = join(base, "repo"); mkdirSync(repo);
  spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });
  const tasks = join(base, "ledger.md");
  writeFileSync(join(repo, "maple.config.json"), JSON.stringify({ docs: { tasks } }));
  writeFileSync(tasks, "# Tasks\n\n## Inbox\n\n- [ ] **#T106 — Existing.** body\n", "utf8");
  const env = { MAPLE_ID_STORE_DIR: join(base, "ids") };

  let r = run(["--root", repo, "add", "Allocated", "--body", "new body", "--set", "priority=P1", "--set", "status=review"], env);
  check("add allocates and inserts fields", r.status === 0 && /Added #T107: Allocated/.test(r.stdout) && /#T107 — Allocated\.\*\* new body\n  priority: P1\n  status: review/.test(readFileSync(tasks, "utf8")), r.stderr.trim());
  r = run(["--root", repo, "set", "107", "area=board", "status=blocked"], env);
  check("set updates valid fields", r.status === 0 && /area: board/.test(readFileSync(tasks, "utf8")) && /status: blocked/.test(readFileSync(tasks, "utf8")), r.stderr.trim());
  r = run(["--root", repo, "set", "107", "bogus=value"], env);
  check("set rejects invalid key", r.status !== 0 && /invalid task field/.test(r.stderr));
  r = run(["--root", repo, "set", "107", "status=nope"], env);
  check("set rejects invalid status", r.status !== 0 && /invalid status/.test(r.stderr));
  r = run(["--root", repo, "done", "107"], env);
  check("done checks box and status", r.status === 0 && /- \[x\] \*\*#T107/.test(readFileSync(tasks, "utf8")) && /status: done/.test(readFileSync(tasks, "utf8")), r.stderr.trim());
  r = run(["--root", repo, "title", "107", "Renamed task"], env);
  check("title renames task", r.status === 0 && /#T107 — Renamed task\.\*\*/.test(readFileSync(tasks, "utf8")), r.stderr.trim());

  const project = join(base, "app-project"); const state = join(project, ".maplelens", "state"); mkdirSync(state, { recursive: true });
  const appTasks = join(base, "app-ledger.md"); writeFileSync(join(project, "maple.config.json"), JSON.stringify({ docs: { tasks: appTasks } })); writeFileSync(appTasks, "## Inbox\n\n- [ ] **#T1 — App task.** body\n");
  const desks = join(base, "desks.json"); writeFileSync(desks, JSON.stringify([{ tenant: "EasyCaller", kind: "local", stateDir: state }]));
  r = run(["--app", "EasyCaller", "list"], { ...env, MAPLE_DESKS_JSON: desks });
  check("--app resolves project from desks", r.status === 0 && /#T1 \[open\] App task/.test(r.stdout), r.stderr.trim());
  r = run(["--app", "Missing", "list"], { ...env, MAPLE_DESKS_JSON: desks });
  check("unknown app fails", r.status !== 0 && /Known local tenants: EasyCaller/.test(r.stderr));
  r = run(["--root", repo, "done", "999"], env);
  check("unknown ID fails", r.status !== 0 && /task #T999 not found/.test(r.stderr));
} finally { rmSync(base, { recursive: true, force: true }); }
if (failed) { console.error(`${failed} assertion(s) FAILED`); process.exit(1); }
console.log("task: all assertions passed.");
