#!/usr/bin/env node
/** Task-ledger CLI. The MapleLens desk, not this CLI, commits ledger edits. */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDocsConfig } from "./lib/config.mjs";
import { allocateAndInsert } from "./next-task-id.mjs";
import { setTaskFields } from "../agent-wt/task-fields.mjs";

const STATUSES = new Set(["open", "in progress", "blocked", "review", "done", "failed", "cancelled"]);
const KEYS = new Set(["status", "priority", "area", "plain", "goal", "size", "worktree", "landed", "blocks", "by"]);
const taskLine = /^- \[([ x])\] \*\*#T(\d+) — (.*?)\.\*\*(.*)$/;

function fail(message) { throw new Error(message); }
function taskRef(value) {
  const m = /^(?:#T)?(\d+)$/.exec(String(value));
  if (!m) fail(`invalid task ID: ${value}`);
  return `#T${Number(m[1])}`;
}
function rootFromGit() {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status !== 0) fail("could not determine repository root; pass --root <repo>");
  return resolve(r.stdout.trim());
}
function localDesks(env) {
  const file = env.MAPLE_DESKS_JSON || resolve(env.LOCALAPPDATA || "", "MapleLens", "desks.json");
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const entries = Array.isArray(data) ? data : data.desks ?? data.entries ?? [];
    return Array.isArray(entries) ? entries : Object.values(entries);
  } catch {
    fail(`could not read MapleLens desks file: ${file}`);
  }
}
function rootFromApp(slug, env) {
  const local = localDesks(env).filter((desk) => desk?.kind === "local");
  const want = String(slug).toLowerCase();
  const desk = local.find((item) => String(item.tenant).toLowerCase() === want || String(item.app ?? "").toLowerCase() === want);
  if (!desk) fail(`unknown app "${slug}". Known local tenants: ${local.map((item) => item.tenant).filter(Boolean).join(", ") || "(none)"}`);
  if (!desk.stateDir) fail(`local app "${slug}" has no stateDir`);
  return dirname(dirname(resolve(desk.stateDir)));
}
function intentTasksFile(root) {
  try {
    const desk = JSON.parse(readFileSync(resolve(root, ".maplelens", "desk.json"), "utf8"));
    if (typeof desk.intentRepo === "string" && desk.intentRepo) return resolve(root, desk.intentRepo, "tasks.md");
  } catch { /* no desk config: fall back to maple.config.json */ }
  return null;
}
function parseField(value) {
  const i = value.indexOf("=");
  if (i <= 0) fail(`invalid field: ${value}`);
  const key = value.slice(0, i);
  const fieldValue = value.slice(i + 1);
  if (!KEYS.has(key)) fail(`invalid task field: ${key}`);
  if (key === "status" && !STATUSES.has(fieldValue)) fail(`invalid status: ${fieldValue}`);
  return [key, fieldValue];
}
function parse(argv) {
  let root = null, app = null;
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") root = argv[++i] || fail("--root requires a value");
    else if (argv[i] === "--app") app = argv[++i] || fail("--app requires a value");
    else args.push(argv[i]);
  }
  if (root && app) fail("use either --root or --app, not both");
  return { root, app, args };
}
function tasksIn(text) {
  const lines = text.split(/\r?\n/), tasks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = taskLine.exec(lines[i]);
    if (!m) continue;
    const fields = {};
    for (let j = i + 1; j < lines.length && !/^- \[[^\]]+\] /.test(lines[j]); j++) {
      const f = /^(?: {2,}|\t+)([^:\s][^:]*):\s?(.*)$/.exec(lines[j]);
      if (f) fields[f[1]] = f[2];
    }
    tasks.push({ line: i, checked: m[1] === "x", id: `#T${m[2]}`, title: m[3], fields });
  }
  return tasks;
}
function requireTask(text, ref) {
  const task = tasksIn(text).find((item) => item.id === ref);
  if (!task) fail(`task ${ref} not found`);
  return task;
}
function write(file, text) { writeFileSync(file, text, "utf8"); }

export async function run(argv, env = process.env) {
  const parsed = parse(argv);
  const root = parsed.app ? rootFromApp(parsed.app, env) : parsed.root ? resolve(parsed.root) : rootFromGit();
  // The desk syncs <intentRepo>/tasks.md; prefer it over maple.config.json so a
  // stale checkout of the app cannot point at an old in-repo ledger.
  const file = intentTasksFile(root) ?? resolveDocsConfig(root, env).tasks;
  const [verb = "list", ...rest] = parsed.args;
  if (verb === "list") {
    if (rest.length && (rest.length !== 2 || rest[0] !== "--status")) fail("usage: list [--status <status>]");
    const status = rest[1];
    if (status && !STATUSES.has(status)) fail(`invalid status: ${status}`);
    const out = tasksIn(readFileSync(file, "utf8"))
      .filter((task) => !task.checked && (!status || (task.fields.status || "open") === status))
      .map((task) => `${task.id} [${task.fields.status || "open"}] ${task.title}`);
    return out.join("\n");
  }
  if (verb === "add") {
    const title = rest.shift();
    if (!title) fail("usage: add <title> [--body ...] [--section ...] [--set key=value]");
    let body = "No details.", section = "Inbox";
    const fields = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--body") body = rest[++i] ?? fail("--body requires a value");
      else if (rest[i] === "--section") section = rest[++i] ?? fail("--section requires a value");
      else if (rest[i] === "--set") fields.push(parseField(rest[++i] ?? fail("--set requires key=value")));
      // Accept `--set a=b c=d` as well as repeated --set flags.
      else if (rest[i].includes("=")) fields.push(parseField(rest[i]));
      else fail(`unknown argument: ${rest[i]}`);
    }
    const id = await allocateAndInsert({ kind: "task", section, title, body, paths: { tasks: file }, env, root });
    if (fields.length) write(file, setTaskFields(readFileSync(file, "utf8"), id, fields));
    return `Added ${id}: ${title}`;
  }
  if (verb === "set") {
    const ref = taskRef(rest.shift());
    if (!rest.length) fail("usage: set <ID> key=value [key=value ...]");
    const fields = rest.map(parseField);
    const text = readFileSync(file, "utf8");
    requireTask(text, ref);
    write(file, setTaskFields(text, ref, fields));
    return `Updated ${ref}: ${fields.map(([k, v]) => `${k}=${v}`).join(", ")}`;
  }
  if (verb === "done") {
    const ref = taskRef(rest[0]);
    if (rest.length !== 1) fail("usage: done <ID>");
    let text = readFileSync(file, "utf8");
    const task = requireTask(text, ref);
    const lines = text.split(/\r?\n/);
    lines[task.line] = lines[task.line].replace("- [ ]", "- [x]");
    text = lines.join(text.includes("\r\n") ? "\r\n" : "\n");
    write(file, setTaskFields(text, ref, [["status", "done"]]));
    return `Done: ${ref}`;
  }
  if (verb === "title") {
    const ref = taskRef(rest.shift());
    const title = rest.shift();
    if (!title || !title.trim() || rest.length) fail('usage: title <ID> "<new title>"');
    const text = readFileSync(file, "utf8");
    const task = requireTask(text, ref);
    const lines = text.split(/\r?\n/);
    lines[task.line] = lines[task.line].replace(taskLine, (_all, box, num, _old, suffix) => `- [${box}] **#T${num} — ${title.replace(/\.$/, "")}.**${suffix}`);
    write(file, lines.join(text.includes("\r\n") ? "\r\n" : "\n"));
    return `Updated title: ${ref}`;
  }
  fail(`unknown command: ${verb}`);
}

function isMain() { return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url); }
if (isMain()) run(process.argv.slice(2)).then((out) => { if (out) process.stdout.write(out + "\n"); }).catch((err) => { process.stderr.write(`${err.message || String(err)}\n`); process.exit(1); });
