// Real concurrency: the non-blocking launcher (proc.mjs / runShellAsync) keeps spawnSync's result shape and failure
// semantics, kills on timeout, and lets the gate's pool overlap checks; per-check times are the check's own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutex, pool, sleep, spawnAsync } from "./proc.mjs";
import { runShell, runShellAsync, shellBin } from "./lib.mjs";
import { runChecks } from "./check-runner.mjs";
import { PRESETS } from "./catalog.mjs";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };
const dir = mkdtempSync(join(tmpdir(), "predeploy-conc-"));
const posix = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
const ctx = { root: dir, outDir: dir, scanRoot: dir, scanRootPosix: posix(dir), sha: "a".repeat(40) };
const overlap = (a, b) => Date.parse(a.startedAt) < Date.parse(b.endedAt) && Date.parse(b.startedAt) < Date.parse(a.endedAt);

await t("runShellAsync returns exactly what runShell returns (status, output, env, cwd)", async () => {
  const cmd = 'echo "out $PD_X"; pwd; echo err 1>&2; exit 3';
  const o = { cwd: dir, env: { PD_X: "hi" }, timeoutSec: 30 };
  const a = await runShellAsync(cmd, o);
  const s = runShell(cmd, o);
  assert.deepEqual(a, s);
  assert.equal(a.status, 3); assert.match(a.stdout, /out hi/);
});

await t("spawnAsync matches spawnSync on stdin input, a missing binary and multi-byte output", async () => {
  const a = await spawnAsync(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "héllo ✓" });
  assert.equal(a.stdout, "héllo ✓"); assert.equal(a.status, 0);
  const missing = await spawnAsync("definitely-not-a-binary-xyz", []);
  const sync = spawnSync("definitely-not-a-binary-xyz", [], { encoding: "utf8" });
  assert.equal(missing.status, null); assert.equal(missing.error.code, sync.error.code); assert.equal(missing.error.message, sync.error.message);
});

await t("output past maxBuffer kills the child with ENOBUFS (as spawnSync does), never silently truncates", async () => {
  const code = "process.stdout.write('x'.repeat(5000)); setTimeout(() => {}, 20000)";
  const t0 = Date.now();
  const a = await spawnAsync(process.execPath, ["-e", code], { maxBuffer: 1000 });
  const s = spawnSync(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000))"], { encoding: "utf8", maxBuffer: 1000 });
  assert.equal(a.error.code, "ENOBUFS"); assert.equal(s.error.code, "ENOBUFS");
  assert.equal(a.status, null); assert.equal(a.stdout.length, 1000);
  assert.ok(Date.now() - t0 < 10000, "the writer was killed, not waited for");
});

await t("a timeout kills the command and its child process tree, reports timedOut, and returns promptly", async () => {
  const pidFile = join(dir, "grandchild.pid");
  const cmd = process.platform === "win32"
    ? `sleep 60 & cat /proc/$!/winpid > ${JSON.stringify(posix(pidFile))}; wait`
    : `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`;
  const t0 = Date.now();
  const r = await runShellAsync(cmd, { timeoutSec: 2 });
  const took = Date.now() - t0;
  assert.equal(r.timedOut, true); assert.equal(r.status, null); assert.equal(r.spawnError, null);
  assert.ok(took < 10000, `returned after ${took}ms`);
  assert.ok(existsSync(pidFile), "the grandchild started");
  if (process.platform === "win32") {
    const pid = readFileSync(pidFile, "utf8").trim();
    await sleep(500);
    const list = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout;
    assert.ok(!new RegExp(`\\b${pid}\\b`).test(list), `grandchild ${pid} survived the timeout kill: ${list.trim()}`);
  }
});

await t("pool keeps item order, never exceeds its width; mutex serialises", async () => {
  let live = 0, peak = 0;
  const out = await pool([300, 50, 200, 10, 100], 2, async (ms, k) => { live++; peak = Math.max(peak, live); await sleep(ms); live--; return k; });
  assert.deepEqual(out, [0, 1, 2, 3, 4]); assert.equal(peak, 2);
  const m = mutex(); let inside = 0, worst = 0;
  await Promise.all([1, 2, 3].map(() => m.run(async () => { inside++; worst = Math.max(worst, inside); await sleep(30); inside--; })));
  assert.equal(worst, 1);
});

const SLEEP = (id, s) => ({ id, command: `sleep ${s}` });

await t("gate checks overlap: 3 x 2 s command checks at concurrency 3 take ~2 s, not >= 6 s", async () => {
  const { results, timing } = await runChecks([SLEEP("a", 2), SLEEP("b", 2), SLEEP("c", 2)], { concurrency: 3 }, ctx);
  assert.ok(timing.wallMs < 4500, `wall ${timing.wallMs}ms; serial would be >= 6000ms`);
  assert.ok(overlap(results[0], results[1]) && overlap(results[1], results[2]) && overlap(results[0], results[2]), "start/end times overlap");
  for (const r of results) { assert.deepEqual(r.findings, []); assert.ok(r.ms >= 1900 && r.ms < 4500, `${r.id} ms=${r.ms}`); }
  assert.ok(timing.checkMsSum >= 5700);
});

await t("concurrency 1 is serial, and a queued check's own ms excludes its wait (queuedMs carries it)", async () => {
  const { results, timing } = await runChecks([SLEEP("a", 1), SLEEP("b", 1), SLEEP("c", 1)], { concurrency: 1 }, ctx);
  assert.ok(timing.wallMs >= 3000, `wall ${timing.wallMs}ms`);
  assert.ok(!overlap(results[0], results[1]) && !overlap(results[1], results[2]));
  assert.ok(results[2].queuedMs >= 1900, `queuedMs ${results[2].queuedMs}`);
  assert.ok(results[2].ms < 2500, `own time ${results[2].ms}ms`);
});

await t("an async check next to a slow command reports its own time (the 29-min advisors artefact is gone)", async () => {
  PRESETS["test-async"] = { run: async () => { await sleep(100); return { findings: [] }; } };
  try {
    const { results } = await runChecks([SLEEP("slow", 3), { id: "quick", preset: "test-async" }], { concurrency: 2 }, ctx);
    const quick = results[1];
    assert.ok(quick.ms < 1500, `async check took ${quick.ms}ms while a 3 s command ran beside it`);
    assert.ok(Date.parse(quick.endedAt) < Date.parse(results[0].endedAt), "it finished before the slow command");
  } finally { delete PRESETS["test-async"]; }
});

await t("results keep config order although the last check finishes first", async () => {
  const { results } = await runChecks([SLEEP("first", 2), SLEEP("second", 1), { id: "third", command: "true" }], { concurrency: 3 }, ctx);
  assert.deepEqual(results.map((r) => r.id), ["first", "second", "third"]);
  assert.ok(Date.parse(results[2].endedAt) < Date.parse(results[0].endedAt));
});

await t("a check timeout still kills and becomes a `timeout` finding without holding up the pool", async () => {
  const t0 = Date.now();
  const { results } = await runChecks([{ id: "hang", command: "sleep 60", timeoutSec: 2 }, SLEEP("ok", 1)], { concurrency: 2 }, ctx);
  assert.deepEqual(results[0].findings.map((f) => f.id), ["timeout"]);
  assert.deepEqual(results[1].findings, []);
  assert.ok(Date.now() - t0 < 10000);
});

await t("exit 127 / non-zero exit / spawn failure keep their findings", async () => {
  const { results } = await runChecks([{ id: "nf", command: "definitely-not-a-real-tool-xyz" }, { id: "bad", command: "exit 4" }], { concurrency: 2 }, ctx);
  assert.equal(results[0].findings[0].id, "tool-missing");
  assert.equal(results[1].findings.length, 1); assert.equal(results[1].raw.status, 4);
  const prev = process.env.MAPLE_SHELL;
  process.env.MAPLE_SHELL = "definitely-not-a-shell-xyz";
  try {
    assert.equal(shellBin(), "definitely-not-a-shell-xyz");
    const { results: r2 } = await runChecks([{ id: "x", command: "true" }], { concurrency: 1 }, ctx);
    assert.equal(r2[0].findings[0].id, "spawn-failed"); assert.match(r2[0].findings[0].message, /ENOENT/);
  } finally { if (prev === undefined) delete process.env.MAPLE_SHELL; else process.env.MAPLE_SHELL = prev; }
});

rmSync(dir, { recursive: true, force: true });
console.log(`\n${n} concurrency tests passed`);
