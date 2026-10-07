/**
 * ci-stack-lock.mjs - one CI stack per repo at a time (D071). A directory lock with the OWNER's pid (the gate run that
 * started the stack, not the short-lived ci-stack process). Same rules as every D066 lock: a LIVE owner is never robbed,
 * however old the lock; a dead owner's lock is reclaimed at once (the caller then sweeps that run's orphaned containers);
 * a lock with no pid yet is reclaimed only after a grace period.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const pidAlive = (pid) => {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e.code === "EPERM"; }
};

const holderOf = (dir) => {
  try { return readFileSync(join(dir, "pid"), "utf8").trim(); } catch { return ""; }
};

/**
 * @returns {{ok:true, reclaimed:boolean, holder?:string} | {ok:false, holder:string, reason:string}}
 * `reclaimed` is true when a dead/pid-less owner's lock was taken over (orphans may exist).
 */
export function takeLock(dir, { pid = process.pid, alive = pidAlive, graceSec = 120 } = {}) {
  mkdirSync(dirname(dir), { recursive: true });
  let reclaimed = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), `${pid}\n`);
      return { ok: true, reclaimed };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const holder = holderOf(dir);
    if (holder && Number(holder) === Number(pid)) {
      return { ok: true, reclaimed: false, holder };
    }
    if (holder && alive(holder)) return { ok: false, holder, reason: `another CI stack run is active (owner pid ${holder}); one CI stack per repo at a time` };
    if (!holder) {
      const age = existsSync(dir) ? (Date.now() - statSync(dir).mtimeMs) / 1000 : Infinity;
      if (age < graceSec) return { ok: false, holder: "?", reason: "a CI stack run is starting (its lock has no pid yet)" };
    }
    rmSync(dir, { recursive: true, force: true });
    reclaimed = true;
  }
  return { ok: false, holder: holderOf(dir) || "?", reason: "could not take the CI stack lock" };
}

/** Release only a lock this pid owns (a dead owner's lock is cleaned by the next takeLock). */
export function releaseLock(dir, pid = process.pid) {
  if (holderOf(dir) === String(pid)) rmSync(dir, { recursive: true, force: true });
}

export const lockHolder = (dir) => (existsSync(dir) ? holderOf(dir) || "?" : null);
