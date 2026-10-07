/**
 * runs.mjs - lifecycle and disk hygiene of the gate's run workspaces (<state>/runs/<id>).
 *
 * Incident 2026-10-07 (EasyCaller): every gate run left a clean-room scan copy plus scanner artefacts under
 * runs/<12-hex> and every live scan left runs/live-<ms>, forever. 298.5 GB later C: had 0 bytes free, Docker
 * froze, a gate hung, worktree creation failed with ENOSPC. Rules now enforced here:
 *
 *   1. A run dir is a DISPOSABLE workspace. beginRun() stamps it with a pid lock; finishRun() (always called from a
 *      finally) deletes the scan copy and every bulky artefact, keeping only run.json and small (<= 2 MB) scanner
 *      reports for debugging. Stamps, reports/, live-scans/ and deploys.jsonl live elsewhere and are never touched.
 *   2. pruneRuns() runs at every gate/live start (covers killed runs) and applies the retention cap:
 *      at most `keep` finished dirs AND at most `maxGB` under runs/, oldest first. A dir whose lock holder is alive
 *      (a concurrent gate in the same repo) is never deleted.
 *   3. preflight() refuses to start below a free-space floor (`minFreeGB`), after the prune.
 *   4. Deletion never follows a link: a run dir may hold node_modules junctions into the real checkout (D012);
 *      removeTree() unlinks every symlink/junction as a link and only recurses into real directories.
 *
 * Never pruned: stamps/, reports/, live-scans/, deploys.jsonl, emergency.*, tf-plugin-cache (a reusable cache).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso, stateDir } from "./lib.mjs";

export const GB = 1024 ** 3;
export const RUNS_DEFAULTS = { keep: 5, maxGB: 10 };
export const MIN_FREE_GB_DEFAULT = 20;
/** Scanner artefacts at or below this size are kept in a finished run dir (debugging a failed run). */
export const KEEP_FILE_BYTES = 2 * 1024 * 1024;
const LOCK = ".run.lock";
const META = "run.json";
/** A lock older than this is treated as stale even if its pid answers (pid reuse); no gate runs this long. */
const LOCK_MAX_AGE_MS = 24 * 3600 * 1000;
/** A lock-less dir younger than this is a run still being created. */
const CREATING_GRACE_MS = 2 * 60 * 1000;

export const runsDir = (root) => join(stateDir(root), "runs");
export const tfCacheDir = (root) => join(stateDir(root), "tf-plugin-cache");

/** The effective retention / floor settings for a normalized predeploy block (or defaults when none). */
export function runSettings(pd) {
  return {
    keep: pd?.runs?.keep ?? RUNS_DEFAULTS.keep,
    maxGB: pd?.runs?.maxGB ?? RUNS_DEFAULTS.maxGB,
    minFreeGB: pd?.minFreeGB ?? MIN_FREE_GB_DEFAULT,
  };
}

// -- link-safe filesystem helpers --------------------------------------------------------------------------

/** Remove a link itself (file symlink, directory symlink or Windows junction) without touching its target. */
function unlinkLink(p, errors) {
  try { unlinkSync(p); return; } catch { /* a directory junction/symlink on some platforms needs rmdir */ }
  try { rmdirSync(p); } catch (e) { errors.push(`${p}: ${e.code || e.message}`); }
}

function unlinkFile(p, errors) {
  try { unlinkSync(p); return; } catch (e) {
    if (e.code !== "EPERM" && e.code !== "EACCES") { errors.push(`${p}: ${e.code || e.message}`); return; }
  }
  try { chmodSync(p, 0o666); unlinkSync(p); } catch (e) { errors.push(`${p}: ${e.code || e.message}`); }
}

/**
 * Delete a file or directory tree WITHOUT ever following a link. Every symlink/junction (the link only) is unlinked;
 * recursion happens only into real directories (lstat, never stat). Never throws; returns the errors.
 */
export function removeTree(p) {
  const errors = [];
  let st;
  try { st = lstatSync(p); } catch { return errors; }
  if (st.isSymbolicLink()) { unlinkLink(p, errors); return errors; }
  if (!st.isDirectory()) { unlinkFile(p, errors); return errors; }
  let names = [];
  try { names = readdirSync(p); } catch (e) { errors.push(`${p}: ${e.code || e.message}`); return errors; }
  for (const n of names) errors.push(...removeTree(join(p, n)));
  try { rmdirSync(p); } catch (e) { errors.push(`${p}: ${e.code || e.message}`); }
  return errors;
}

/** Bytes under p, counting links as themselves (never followed). */
export function dirBytes(p) {
  let st;
  try { st = lstatSync(p); } catch { return 0; }
  if (st.isSymbolicLink() || !st.isDirectory()) return st.size;
  let total = 0;
  let names = [];
  try { names = readdirSync(p); } catch { return 0; }
  for (const n of names) total += dirBytes(join(p, n));
  return total;
}

export function freeBytes(path) {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export const fmtGB = (b) => (b / GB >= 0.1 ? (b / GB).toFixed(1) + " GB" : (b / (1024 * 1024)).toFixed(1) + " MB");

// -- run lock ----------------------------------------------------------------------------------------------
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** "live" (an owner is running), "stale" (a lock whose owner is gone) or "none" (finished / legacy dir). */
export function lockState(dir, now = Date.now()) {
  let lock = null;
  try { lock = JSON.parse(readFileSync(join(dir, LOCK), "utf8")); } catch { /* absent or torn */ }
  if (lock) {
    const started = Date.parse(lock.startedAt);
    const fresh = Number.isFinite(started) && now - started < LOCK_MAX_AGE_MS;
    return pidAlive(lock.pid) && fresh ? "live" : "stale";
  }
  try {
    if (now - lstatSync(dir).mtimeMs < CREATING_GRACE_MS && !existsSync(join(dir, META))) return "live";
  } catch { /* gone */ }
  return "none";
}

/**
 * Create a fresh run workspace and lock it with this process's pid. When `name` is held by another live run (two
 * gates on the same sha in one repo) a pid-suffixed name is used instead, so a concurrent run is never clobbered.
 * @returns {{dir:string, name:string}}
 */
export function beginRun(root, name) {
  const base = runsDir(root);
  mkdirSync(base, { recursive: true });
  let use = name;
  if (existsSync(join(base, use))) {
    if (lockState(join(base, use)) === "live") use = `${name}-${process.pid}`;
    removeTree(join(base, use));
  }
  const dir = join(base, use);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, LOCK), JSON.stringify({ pid: process.pid, startedAt: nowIso(), name: use }));
  return { dir, name: use };
}

/**
 * End a run (call from a finally): delete the scan copy and every bulky artefact, keep run.json + small reports,
 * then release the lock. Never throws.
 * @returns {{freedBytes:number, errors:string[]}}
 */
export function finishRun(run, info = {}) {
  const before = dirBytes(run.dir);
  const errors = [];
  try {
    for (const n of readdirSync(run.dir)) {
      if (n === LOCK || n === META) continue;
      const p = join(run.dir, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink() || (st.isDirectory() && n !== "out")) errors.push(...removeTree(p));
      else if (st.isDirectory()) {
        for (const c of readdirSync(p)) {
          const cp = join(p, c);
          let cs;
          try { cs = lstatSync(cp); } catch { continue; }
          if (cs.isSymbolicLink() || !cs.isFile() || cs.size > KEEP_FILE_BYTES) errors.push(...removeTree(cp));
        }
      } else if (st.size > KEEP_FILE_BYTES) errors.push(...removeTree(p));
    }
    writeFileSync(join(run.dir, META), JSON.stringify({ name: run.name, ...info, endedAt: nowIso() }, null, 2) + "\n");
  } catch (e) {
    errors.push(String(e.message || e));
  }
  try { unlinkSync(join(run.dir, LOCK)); } catch { /* already gone */ }
  return { freedBytes: Math.max(0, before - dirBytes(run.dir)), errors };
}

// -- retention --------------------------------------------------------------------------------------------
function listRuns(base) {
  let names = [];
  try { names = readdirSync(base); } catch { return []; }
  const out = [];
  for (const name of names) {
    const dir = join(base, name);
    let st;
    try { st = lstatSync(dir); } catch { continue; }
    if (st.isSymbolicLink()) { out.push({ name, dir, link: true, mtime: 0 }); continue; }
    if (!st.isDirectory()) continue;
    let ended = NaN;
    try { ended = Date.parse(JSON.parse(readFileSync(join(dir, META), "utf8")).endedAt); } catch { /* legacy dir */ }
    out.push({ name, dir, mtime: Number.isFinite(ended) ? ended : st.mtimeMs });
  }
  return out;
}

/**
 * Prune runs/: orphaned runs (dead owner) always; then, oldest first, anything beyond `keep` finished dirs or beyond
 * `maxGB` under runs/. `all` removes every finished dir. A dir with a live owner is never removed.
 * @returns {{removed:{name:string,bytes:number,reason:string}[], kept:string[], live:string[], errors:string[], freedBytes:number, totalBytes:number}}
 */
export function pruneRuns(root, { keep = RUNS_DEFAULTS.keep, maxGB = RUNS_DEFAULTS.maxGB, all = false, now = Date.now() } = {}) {
  const base = runsDir(root);
  const res = { removed: [], kept: [], live: [], errors: [], freedBytes: 0, totalBytes: 0 };
  const drop = (r, reason) => {
    const bytes = dirBytes(r.dir);
    const errs = removeTree(r.dir);
    res.errors.push(...errs);
    res.removed.push({ name: r.name, bytes, reason });
    res.freedBytes += bytes;
  };
  const finished = [];
  for (const r of listRuns(base)) {
    if (r.link) { res.errors.push(...removeTree(r.dir)); continue; }
    const st = lockState(r.dir, now);
    if (st === "live") res.live.push(r.name);
    else if (st === "stale") drop(r, "orphaned run (its process is gone)");
    else finished.push(r);
  }
  finished.sort((a, b) => b.mtime - a.mtime); // newest first
  let survivors = finished;
  if (all) { for (const r of finished) drop(r, "--all"); survivors = []; }
  else {
    survivors = finished.slice(0, Math.max(0, keep));
    for (const r of finished.slice(Math.max(0, keep))) drop(r, `over the ${keep}-run retention`);
  }
  const sizes = new Map(survivors.map((r) => [r.name, dirBytes(r.dir)]));
  let total = [...sizes.values()].reduce((a, b) => a + b, 0) + res.live.reduce((a, n) => a + dirBytes(join(base, n)), 0);
  const cap = maxGB * GB;
  for (let i = survivors.length - 1; i >= 0 && total > cap; i--) {
    const r = survivors[i];
    drop(r, `over the ${maxGB} GB cap`);
    total -= sizes.get(r.name);
    sizes.delete(r.name);
  }
  res.kept = survivors.filter((r) => sizes.has(r.name)).map((r) => r.name);
  res.totalBytes = Math.max(0, total);
  return res;
}

// -- disk report / preflight --------------------------------------------------------------------------------
export function diskReport(root, pd, free = freeBytes) {
  const s = runSettings(pd);
  const base = runsDir(root);
  const runs = listRuns(base).filter((r) => !r.link);
  const live = runs.filter((r) => lockState(r.dir) === "live").length;
  const state = stateDir(root);
  return {
    state, runsDir: base, runsCount: runs.length, runsLive: live, runsBytes: runs.reduce((a, r) => a + dirBytes(r.dir), 0),
    tfCacheBytes: dirBytes(tfCacheDir(root)), freeBytes: free(state), settings: s,
  };
}

/** One summary block: runs/ size and count, tf-plugin-cache size, free space and the configured limits. */
export function diskLines(d) {
  const free = d.freeBytes === null ? "unknown" : fmtGB(d.freeBytes);
  return [
    `runs/: ${d.runsCount} dir(s), ${fmtGB(d.runsBytes)}${d.runsLive ? ` (${d.runsLive} in progress)` : ""}  [keep ${d.settings.keep}, cap ${d.settings.maxGB} GB]  ${d.runsDir}`,
    `tf-plugin-cache: ${fmtGB(d.tfCacheBytes)} (a reusable cache; never pruned)`,
    `free space on the repo drive: ${free}  [floor ${d.settings.minFreeGB} GB]`,
  ];
}

/** Pure: the refusal text for a free-space floor breach (null when fine or unknown). */
export function lowSpaceMessage(d, pruneCmd) {
  if (d.freeBytes === null || d.freeBytes >= d.settings.minFreeGB * GB) return null;
  return `refusing to start: only ${fmtGB(d.freeBytes)} free on the drive holding this repo, floor is ${d.settings.minFreeGB} GB (predeploy.minFreeGB).\n` +
    `  runs/ holds ${fmtGB(d.runsBytes)} in ${d.runsCount} dir(s) (${d.runsDir}); tf-plugin-cache ${fmtGB(d.tfCacheBytes)}.\n` +
    `  Free space (empty the Docker/pnpm caches, remove old worktrees), or prune the run workspaces: ${pruneCmd}`;
}

/**
 * Start-of-run hygiene for a gate or live scan: prune runs/ (kills nothing in progress), then check the floor.
 * @returns {{ok:boolean, message?:string, pruned:object}}
 */
export function preflight(root, pd, { pruneCmd = "node <plugin>/scripts/predeploy/run.mjs prune --all", log = () => {}, free = freeBytes } = {}) {
  const s = runSettings(pd);
  const pruned = pruneRuns(root, { keep: s.keep, maxGB: s.maxGB });
  if (pruned.removed.length) log(`pruned ${pruned.removed.length} old run workspace(s), freed ${fmtGB(pruned.freedBytes)}`);
  const msg = lowSpaceMessage(diskReport(root, pd, free), pruneCmd);
  return msg ? { ok: false, message: msg, pruned } : { ok: true, pruned };
}

/** `run.mjs prune [--all] [--root DIR] [--json]` */
export function pruneCli(argv, root, pd, { pruneCmd } = {}) {
  const all = argv.includes("--all");
  const s = runSettings(pd);
  const r = pruneRuns(root, { keep: s.keep, maxGB: s.maxGB, all });
  if (argv.includes("--json")) { console.log(JSON.stringify(r, null, 2)); return r.errors.length ? 1 : 0; }
  for (const x of r.removed) console.log(`removed ${x.name} (${fmtGB(x.bytes)}): ${x.reason}`);
  for (const n of r.live) console.log(`kept ${n}: a gate is running in it`);
  console.log(`pruned ${r.removed.length} run workspace(s), freed ${fmtGB(r.freedBytes)}; ${r.kept.length + r.live.length} left (${fmtGB(r.totalBytes)})${all ? "" : `  [run \`${pruneCmd || "run.mjs prune --all"}\` to clear every finished one]`}`);
  for (const l of diskLines(diskReport(root, pd))) console.log(l);
  for (const e of r.errors.slice(0, 10)) console.error(`could not remove: ${e}`);
  return r.errors.length ? 1 : 0;
}
