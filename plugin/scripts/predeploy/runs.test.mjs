// Run-workspace hygiene (D068): prune at run end / startup, retention caps, live-owner protection, link safety,
// the free-space floor, the config keys, and proof that evidence (stamps, reports, ledger, live scans, cache) is never pruned.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configHash, normalize, validatePredeploy } from "./config.mjs";
import { stateDir } from "./lib.mjs";
import { GB, KEEP_FILE_BYTES, beginRun, dirBytes, diskLines, diskReport, finishRun, lockState, lowSpaceMessage, preflight, pruneCli, pruneRuns, removeTree, runsDir } from "./runs.mjs";
import { isRunWorkspaceMaintenance, touchesGateState } from "../../hooks/guards/deploy-guard.mjs";
import { parseShell } from "../../hooks/guards/shell.mjs";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };

const scratch = mkdtempSync(join(tmpdir(), "predeploy-runs-"));
process.on("exit", () => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;
function repo() {
  const dir = join(scratch, "r" + ++seq);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "maple.config.json"), "{}");
  return dir;
}
const put = (p, bytes = 10) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, Buffer.alloc(bytes, 97)); };
/** A finished run dir with an `endedAt` that sorts by `ageMin` (older = larger). */
function finished(root, name, { ageMin = 0, bytes = 1000 } = {}) {
  const d = join(runsDir(root), name);
  put(join(d, "out", "r.json"), bytes);
  writeFileSync(join(d, "run.json"), JSON.stringify({ name, endedAt: new Date(Date.now() - ageMin * 60000).toISOString() }));
  const when = new Date(Date.now() - ageMin * 60000);
  utimesSync(d, when, when);
  return d;
}
const deadPid = (() => { const r = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }); return Number(r.stdout); })();
const OLD = Date.now() - 3600 * 1000; // dirs older than the 2-minute "being created" grace
const age = (d) => { const w = new Date(OLD); utimesSync(d, w, w); };

// -- link safety (D012) --------------------------------------------------------------------------------------
t("removeTree never follows a junction/symlink: the target survives, only the link goes", () => {
  const target = join(scratch, "sentinel"); put(join(target, "keep.txt"), 5); put(join(target, "deep", "keep2.txt"), 5);
  const tree = join(scratch, "tree1");
  put(join(tree, "a", "f.txt"));
  symlinkSync(target, join(tree, "a", "node_modules"), "junction"); // a real junction on Windows, a symlink elsewhere
  try { symlinkSync(join(target, "keep.txt"), join(tree, "filelink"), "file"); } catch { /* file symlinks need a privilege on Windows; the junction above is the case that matters */ }
  assert.equal(removeTree(tree).length, 0);
  assert.ok(!existsSync(tree));
  assert.equal(readFileSync(join(target, "keep.txt"), "utf8"), "aaaaa");
  assert.ok(existsSync(join(target, "deep", "keep2.txt")), "the junction target's contents must be intact");
});
t("removeTree on a link itself unlinks it and leaves the target", () => {
  const target = join(scratch, "sentinel2"); put(join(target, "x.txt"), 3);
  const link = join(scratch, "lnk2");
  symlinkSync(target, link, "junction");
  assert.equal(removeTree(link).length, 0);
  assert.ok(!existsSync(link) && existsSync(join(target, "x.txt")));
});
t("dirBytes counts a link as itself, not the target", () => {
  const target = join(scratch, "sentinel3"); put(join(target, "big.bin"), 200000);
  const tree = join(scratch, "tree3"); put(join(tree, "f"), 10);
  symlinkSync(target, join(tree, "nm"), "junction");
  assert.ok(dirBytes(tree) < 100000);
});
t("pruning a run dir that holds a junction into a checkout leaves the checkout intact", () => {
  const root = repo();
  const checkout = join(scratch, "checkout"); put(join(checkout, "node_modules", "pkg", "index.js"), 7);
  const d = finished(root, "aaaaaaaaaaaa", { ageMin: 10 });
  symlinkSync(join(checkout, "node_modules"), join(d, "tree-node_modules"), "junction");
  const r = pruneRuns(root, { keep: 0 });
  assert.deepEqual(r.removed.map((x) => x.name), ["aaaaaaaaaaaa"]);
  assert.ok(existsSync(join(checkout, "node_modules", "pkg", "index.js")));
});

// -- run lifecycle ------------------------------------------------------------------------------------------
t("finishRun keeps run.json and small reports, deletes the scan copy, big artefacts and links, releases the lock", () => {
  const root = repo();
  const run = beginRun(root, "bbbbbbbbbbbb");
  assert.equal(lockState(run.dir), "live");
  put(join(run.dir, "tree", "src", "a.js"), 5000);
  put(join(run.dir, "out", "semgrep.json"), 100);
  put(join(run.dir, "out", "image-x.tar"), KEEP_FILE_BYTES + 1);
  put(join(run.dir, "out", "nested", "cache.bin"), 10);
  put(join(run.dir, "zap-report.json"), KEEP_FILE_BYTES + 5);
  put(join(run.dir, "plan.yaml"), 50);
  const checkout = join(scratch, "checkout2"); put(join(checkout, "f.txt"), 1);
  symlinkSync(checkout, join(run.dir, "tree", "node_modules"), "junction");
  const done = finishRun(run, { sha: "abc", exit: 1 });
  assert.deepEqual(done.errors, []);
  assert.deepEqual(readdirSync(run.dir).sort(), ["out", "plan.yaml", "run.json"]);
  assert.deepEqual(readdirSync(join(run.dir, "out")), ["semgrep.json"]);
  assert.equal(JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8")).exit, 1);
  assert.ok(existsSync(join(checkout, "f.txt")));
  assert.notEqual(lockState(run.dir), "live");
  assert.ok(done.freedBytes >= 5000);
});
t("an exception inside the run still prunes it (the try/finally contract)", () => {
  const root = repo();
  let run;
  assert.throws(() => {
    run = beginRun(root, "cccccccccccc");
    try { put(join(run.dir, "tree", "big.js"), 4000); throw new Error("scanner exploded"); } finally { finishRun(run, { exit: 2 }); }
  }, /exploded/);
  assert.ok(!existsSync(join(run.dir, "tree")));
  assert.ok(existsSync(join(run.dir, "run.json")));
});
t("a second run on the same name while the first is live gets its own dir and does not clobber the first", () => {
  const root = repo();
  const a = beginRun(root, "dddddddddddd");
  put(join(a.dir, "tree", "keep.js"));
  const b = beginRun(root, "dddddddddddd");
  assert.notEqual(a.dir, b.dir);
  assert.ok(existsSync(join(a.dir, "tree", "keep.js")));
  finishRun(b); finishRun(a);
});
t("a finished (unlocked) dir of the same name is replaced", () => {
  const root = repo();
  const d = finished(root, "eeeeeeeeeeee");
  const run = beginRun(root, "eeeeeeeeeeee");
  assert.equal(run.dir, d);
  assert.ok(!existsSync(join(d, "out", "r.json")));
  finishRun(run);
});

// -- startup prune, concurrency, retention ------------------------------------------------------------------
t("pruning never deletes a run whose owner pid is alive, and does delete an orphan whose pid is gone", () => {
  const root = repo();
  const live = beginRun(root, "111111111111"); put(join(live.dir, "tree", "f"), 3000); age(live.dir);
  const orphan = join(runsDir(root), "222222222222");
  put(join(orphan, "tree", "f"), 3000);
  writeFileSync(join(orphan, ".run.lock"), JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }));
  const r = pruneRuns(root, { keep: 0, maxGB: 0.000001 }); // as aggressive as the caps go
  assert.deepEqual(r.live, ["111111111111"]);
  assert.deepEqual(r.removed.map((x) => x.name), ["222222222222"]);
  assert.match(r.removed[0].reason, /orphan/);
  assert.ok(existsSync(join(live.dir, "tree", "f")));
  assert.equal(pruneRuns(root, { keep: 0, all: true }).live.length, 1, "--all spares a live run too");
  finishRun(live);
});
t("a lock older than a day is stale even if the pid answers (pid reuse)", () => {
  const root = repo();
  const d = join(runsDir(root), "333333333333"); put(join(d, "tree", "f"));
  writeFileSync(join(d, ".run.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 25 * 3600 * 1000).toISOString() }));
  assert.equal(lockState(d), "stale");
});
t("a lock-less dir younger than the creation grace is spared; a legacy old one is pruned", () => {
  const root = repo();
  const fresh = join(runsDir(root), "444444444444"); put(join(fresh, "tree", "f"));
  const legacy = join(runsDir(root), "555555555555"); put(join(legacy, "tree", "f")); age(legacy);
  const r = pruneRuns(root, { keep: 0 });
  assert.deepEqual(r.live, ["444444444444"]);
  assert.deepEqual(r.removed.map((x) => x.name), ["555555555555"]);
});
t("keep=N: the newest N finished dirs stay, older ones go (oldest first)", () => {
  const root = repo();
  for (let i = 0; i < 8; i++) finished(root, "run" + i, { ageMin: 10 + i * 10 }); // run0 newest
  const r = pruneRuns(root, { keep: 3, maxGB: 10 });
  assert.deepEqual([...r.kept].sort(), ["run0", "run1", "run2"]);
  assert.equal(r.removed.length, 5);
  assert.ok(r.removed.every((x) => /retention/.test(x.reason)));
});
t("maxGB: the stricter of count and size wins; oldest are dropped until under the cap", () => {
  const root = repo();
  for (let i = 0; i < 4; i++) finished(root, "big" + i, { ageMin: 10 + i * 10, bytes: 400 * 1024 });
  const capGB = (900 * 1024) / GB; // fits two of the four (count cap of 5 alone would keep all)
  const r = pruneRuns(root, { keep: 5, maxGB: capGB });
  assert.deepEqual([...r.kept].sort(), ["big0", "big1"]);
  assert.ok(r.removed.every((x) => /GB cap/.test(x.reason)));
  assert.ok(r.totalBytes <= 900 * 1024);
});
t("--all clears every finished run", () => {
  const root = repo();
  for (let i = 0; i < 3; i++) finished(root, "f" + i, { ageMin: i });
  const r = pruneRuns(root, { all: true });
  assert.equal(r.removed.length, 3);
  assert.deepEqual(readdirSync(runsDir(root)), []);
});
t("a stray link directly under runs/ is unlinked, not followed", () => {
  const root = repo();
  const target = join(scratch, "sentinel4"); put(join(target, "x"), 2);
  mkdirSync(runsDir(root), { recursive: true });
  symlinkSync(target, join(runsDir(root), "live-1"), "junction");
  pruneRuns(root, { keep: 0, all: true });
  assert.ok(existsSync(join(target, "x")));
  assert.throws(() => lstatSync(join(runsDir(root), "live-1")));
});

// -- evidence is never pruned --------------------------------------------------------------------------------
t("prune --all never touches stamps, reports, deploys ledger, live-scan records, emergency files or the tf plugin cache", () => {
  const root = repo();
  const s = stateDir(root);
  const evidence = {
    "stamps/abc.json": '{"status":"pass"}', "reports/abc.json": '{"status":"pass"}', "deploys.jsonl": '{"seq":1}\n',
    "live-scans/2026-10-07T00-00-00-000Z.json": "{}", "live-scans/live-1.zap.log": "log", "live-scans/x-zap-report.json": "{}",
    "emergency.json": "{}", "emergency.log.jsonl": "{}\n", "tf-plugin-cache/registry/x.zip": "zip",
  };
  for (const [f, c] of Object.entries(evidence)) { mkdirSync(join(s, f, ".."), { recursive: true }); writeFileSync(join(s, f), c); }
  finished(root, "old1", { ageMin: 99 }); finished(root, "old2", { ageMin: 5 });
  const log = console.log; console.log = () => {};
  try { assert.equal(pruneCli(["--all"], root, normalize({ predeploy: { checks: [] } })), 0); } finally { console.log = log; }
  assert.deepEqual(readdirSync(runsDir(root)), []);
  for (const [f, c] of Object.entries(evidence)) assert.equal(readFileSync(join(s, f), "utf8"), c, f + " must survive a prune");
});

// -- disk-space preflight ------------------------------------------------------------------------------------
t("lowSpaceMessage: silent above the floor or when unknown; below it names free space, runs/ size and the prune command", () => {
  const d = (freeGB) => ({ freeBytes: freeGB === null ? null : freeGB * GB, runsBytes: 3 * GB, runsCount: 4, runsDir: "/r", tfCacheBytes: GB, settings: { minFreeGB: 20, keep: 5, maxGB: 10 } });
  assert.equal(lowSpaceMessage(d(50), "x"), null);
  assert.equal(lowSpaceMessage(d(null), "x"), null);
  const m = lowSpaceMessage(d(5), "node run.mjs prune --all");
  assert.match(m, /5\.0 GB free/); assert.match(m, /floor is 20 GB/); assert.match(m, /3\.0 GB in 4 dir/); assert.match(m, /node run\.mjs prune --all/);
});
t("preflight prunes first, then refuses below the floor (also after the prune), and passes with room", () => {
  const root = repo();
  for (let i = 0; i < 7; i++) finished(root, "p" + i, { ageMin: i * 5 });
  const pd = normalize({ predeploy: { checks: [], runs: { keep: 2 }, minFreeGB: 30 } });
  const low = preflight(root, pd, { free: () => 10 * GB });
  assert.equal(low.ok, false);
  assert.equal(low.pruned.removed.length, 5, "the startup prune ran before the check");
  assert.match(low.message, /refusing to start/);
  assert.equal(readdirSync(runsDir(root)).length, 2);
  assert.equal(preflight(root, pd, { free: () => 40 * GB }).ok, true);
});
t("diskReport/diskLines report runs/ size+count, tf cache size and free space", () => {
  const root = repo();
  finished(root, "d1", { bytes: 5000 });
  mkdirSync(join(stateDir(root), "tf-plugin-cache"), { recursive: true }); writeFileSync(join(stateDir(root), "tf-plugin-cache", "p"), Buffer.alloc(3000));
  const d = diskReport(root, normalize({ predeploy: { checks: [] } }), () => 123 * GB);
  assert.equal(d.runsCount, 1); assert.ok(d.runsBytes >= 5000); assert.ok(d.tfCacheBytes >= 3000); assert.equal(d.freeBytes, 123 * GB);
  const text = diskLines(d).join("\n");
  assert.match(text, /runs\/: 1 dir/); assert.match(text, /tf-plugin-cache/); assert.match(text, /123\.0 GB/);
});

// -- config -------------------------------------------------------------------------------------------------
const base = (extra = {}) => ({ predeploy: { checks: [{ id: "a", command: "node -e 0" }], ...extra } });
t("config: defaults are keep 5, maxGB 10, minFreeGB 20; overrides merge per key", () => {
  assert.deepEqual(validatePredeploy(base()), []);
  const d = normalize(base());
  assert.deepEqual(d.runs, { keep: 5, maxGB: 10 }); assert.equal(d.minFreeGB, 20);
  const o = normalize(base({ runs: { keep: 2 }, minFreeGB: 50 }));
  assert.deepEqual(o.runs, { keep: 2, maxGB: 10 }); assert.equal(o.minFreeGB, 50);
});
t("config: runs/minFreeGB validation", () => {
  assert.deepEqual(validatePredeploy(base({ runs: { keep: 0, maxGB: 0.5 }, minFreeGB: 1 })), []);
  for (const bad of [{ runs: { keep: -1 } }, { runs: { keep: 1.5 } }, { runs: { keep: 101 } }, { runs: { maxGB: 0 } }, { runs: { maxGB: "10" } }, { runs: { nope: 1 } }, { runs: [] }, { minFreeGB: 0 }, { minFreeGB: "20" }, { minFreeGB: 5000 }]) {
    assert.ok(validatePredeploy(base(bad)).some((e) => /predeploy\.(runs|minFreeGB)/.test(e)), JSON.stringify(bad));
  }
});
t("config: retuning the disk knobs does not invalidate stamps (they are not part of the certified config hash)", () => {
  assert.equal(configHash(normalize(base())), configHash(normalize(base({ runs: { keep: 1, maxGB: 1 }, minFreeGB: 99 }))));
  assert.notEqual(configHash(normalize(base())), configHash(normalize(base({ stampTtlHours: 1 }))));
});
t("config schema documents the new keys", () => {
  const schema = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "schema", "maple.config.schema.json"), "utf8"));
  const p = schema.properties.predeploy.properties;
  assert.deepEqual(Object.keys(p.runs.properties).sort(), ["keep", "maxGB"]);
  assert.equal(p.minFreeGB.type, "number");
});

// -- guard: an agent may prune/doctor, nothing else under maple/predeploy ------------------------------------
const segOf = (c, shell = "bash") => parseShell(c, shell)[0];
t("guard: run.mjs prune/doctor with the sanctioned flags is maintenance; anything else is not", () => {
  for (const c of ["node plugin/scripts/predeploy/run.mjs prune", 'node "C:\\p\\scripts\\predeploy\\run.mjs" prune --all', "node /p/scripts/predeploy/run.mjs doctor --json", "node plugin/scripts/predeploy/run.mjs prune --root C:/r/.git/maple/predeploy"]) {
    assert.ok(isRunWorkspaceMaintenance(segOf(c)), c);
    assert.ok(!touchesGateState(c), c);
  }
  for (const c of ["node plugin/scripts/predeploy/run.mjs", "node plugin/scripts/predeploy/run.mjs --live", "node plugin/scripts/predeploy/run.mjs prune --out x", "node plugin/scripts/predeploy/run.mjs prune > a", "node x.mjs prune", "node plugin/scripts/predeploy/verify.mjs prune", "bash plugin/scripts/predeploy/run.mjs prune"]) {
    assert.ok(!isRunWorkspaceMaintenance(segOf(c)), c);
  }
  assert.ok(touchesGateState("rm -rf .git/maple/predeploy/runs"));
  assert.ok(touchesGateState("node plugin/scripts/predeploy/run.mjs prune && echo {} > .git/maple/predeploy/stamps/x.json"));
});

console.log(`\n${n} runs tests passed`);
