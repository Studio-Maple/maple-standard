#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTaskFields } from "./task-fields.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const eq = (name, actual, expected) => check(name, actual === expected, actual === expected ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const base = "- [ ] **#T100 — First.** body\n- [ ] **#T101 — Second.** body\n";
eq(
  "inserts into a bullet with no fields",
  setTaskFields(base, "#T100", { worktree: "agent/one" }),
  "- [ ] **#T100 — First.** body\n  worktree: agent/one\n- [ ] **#T101 — Second.** body\n",
);

eq(
  "replaces an existing field",
  setTaskFields("- [ ] **#T100 — First.** body\n  worktree: agent/old\n", "#T100", { worktree: "agent/new" }),
  "- [ ] **#T100 — First.** body\n  worktree: agent/new\n",
);

eq(
  "sets several fields in one call",
  setTaskFields("- [ ] **#T100 — First.** body\n  worktree: agent/one\n", "#T100", new Map([["landed", "2026-09-23 abc1234"], ["status", "review"]])),
  "- [ ] **#T100 — First.** body\n  worktree: agent/one\n  landed: 2026-09-23 abc1234\n  status: review\n",
);

const crlf = "- [ ] **#T100 — First.** body\r\n- [ ] **#T101 — Second.** body\r\n";
const crlfOut = setTaskFields(crlf, "#T100", { status: "review" });
check("preserves CRLF line endings", crlfOut.includes("\r\n") && !crlfOut.includes("body\n"));

eq("CRLF output content", crlfOut, "- [ ] **#T100 — First.** body\r\n  status: review\r\n- [ ] **#T101 — Second.** body\r\n");

const twoTasks = "- [ ] **#T100 — First.** body\n  status: todo\n- [ ] **#T101 — Second.** body\n  status: todo\n";
const touched = setTaskFields(twoTasks, "#T100", { status: "review" });
check("other tasks untouched", touched.includes("- [ ] **#T101 — Second.** body\n  status: todo\n"));

let threw = false;
try {
  setTaskFields(base, "#T999", { status: "review" });
} catch (err) {
  threw = /#T999.*not found/.test(String(err?.message || err));
}
check("unknown ref throws", threw);

const sb = mkdtempSync(join(tmpdir(), "maple-task-fields-"));
try {
  const tasks = join(sb, "absolute-tasks.md");
  writeFileSync(join(sb, "maple.config.json"), JSON.stringify({ docs: { tasks } }), "utf8");
  writeFileSync(tasks, "- [ ] **#T200 — CLI.** body\n", "utf8");
  const r = spawnSync(process.execPath, [join(HERE, "task-fields.mjs"), "--root", sb, "--task", "#T200", "--set", "worktree=agent/cli", "--set", "status=review"], { encoding: "utf8" });
  check("CLI exits zero with absolute docs.tasks", r.status === 0, r.status === 0 ? "" : `${r.stderr || r.stdout}`.trim());
  eq(
    "CLI round-trip rewrites tasks file",
    existsSync(tasks) ? readFileSync(tasks, "utf8") : "",
    "- [ ] **#T200 — CLI.** body\n  worktree: agent/cli\n  status: review\n",
  );
} finally {
  rmSync(sb, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log("task-fields: all assertions passed.");
