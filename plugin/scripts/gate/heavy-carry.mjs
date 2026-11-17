/**
 * heavy-carry.mjs - the git-backed proof behind heavy stamp carry-over (opt-in `gate.heavyCarryOver`, amends D060/D066).
 *
 * A heavy-pass record with `via: "carry"` says: "HEAD's tree differs from a commit with a REAL green heavy run (the
 * origin, `carriedFrom`) only in in-place edits of allow-listed data files". It is written by `gate-cli carry` and
 * NEVER trusted as written: every reader that lets it count (verifyPromotion, the fast lane) re-runs carryEligibility
 * from git objects at check time, with `carriedFrom` as the only input taken from the record.
 *
 * Eligibility (each refusal has a `code`):
 *   disabled              HEAD's committed maple.config.json does not switch gate.heavyCarryOver on (or cannot be read)
 *   no-origin             no commit on HEAD's first-parent chain (within MAX_DISTANCE) has a real heavy record
 *   not-first-parent      the claimed origin is not on HEAD's first-parent chain within MAX_DISTANCE commits
 *   origin-invalid        the origin's record is missing, names another sha, or its tree does not match the commit
 *   origin-is-carry       the origin's record is itself a carry (chains are always evaluated against the real run)
 *   carry-config-changed  the `gate` block differs between origin and HEAD (carry rules cannot loosen themselves)
 *   diff                  a changed path is not an in-place content edit of a listed regular file
 *   config-keys           maple.config.json changed outside the listed configKeys (or structurally, or in a denied key)
 * Chosen: FIRST-PARENT ancestry. The release line (landing branch -> production) is a first-parent history; an origin
 * reached only through a merged side branch is refused, which is stricter and keeps search and check-time agreement
 * trivial. What carries is decided by the TREE diff origin..HEAD (git diff --raw), which covers every commit between.
 *
 * Git is run with replace objects disabled and the object-store / index / repo-redirecting GIT_* variables removed.
 * Zero dependencies on gate-state.mjs (it imports this file): the stamp reader is injected.
 */
import { spawnSync } from "node:child_process";
import { CONFIG_FILE, MAX_DISTANCE, judgeConfigChange, judgeEntries, normalizeHeavyCarry } from "./heavy-carry-rules.mjs";

const SCRUB = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_REPLACE_REF_BASE", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_NAMESPACE", "GIT_GRAFT_FILE"];
function gitEnv() {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  for (const k of SCRUB) delete env[k];
  for (const k of Object.keys(env)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
  return env;
}

/** @returns {{ok:boolean, out:string}} */
function gitRaw(root, args) {
  const r = spawnSync("git", ["-c", "core.quotepath=false", ...args], { cwd: root, encoding: "utf8", env: gitEnv(), maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

const short = (s) => String(s || "").slice(0, 8);
const refuse = (code, reason, extra = {}) => ({ ok: false, code, reason, ...extra });
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/** maple.config.json as committed at `sha`: {cfg} (null when absent) or {error}. Never the working tree. */
export function configAt(root, sha) {
  const exists = gitRaw(root, ["cat-file", "-e", `${sha}:${CONFIG_FILE}`]);
  if (!exists.ok) return { cfg: null };
  const r = gitRaw(root, ["cat-file", "blob", `${sha}:${CONFIG_FILE}`]);
  if (!r.ok) return { error: `cannot read ${CONFIG_FILE} at ${short(sha)}` };
  try { return { cfg: JSON.parse(r.out.replace(/^﻿/, "")) }; } catch (e) { return { error: `${CONFIG_FILE} at ${short(sha)} is not valid JSON (${e.message})` }; }
}

/** `git diff --raw` origin..head as {status, oldMode, newMode, path}; renames are a delete + an add. */
export function rawDiff(root, from, to) {
  const r = gitRaw(root, ["diff", "--raw", "--no-renames", "--no-abbrev", "--no-ext-diff", "--no-textconv", "-z", from, to, "--"]);
  if (!r.ok) throw new Error(`git diff ${short(from)}..${short(to)} failed`);
  const parts = r.out.split("\0");
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode, newMode, , , status] = parts[i].replace(/^:/, "").split(" ");
    out.push({ status: (status || "").charAt(0), oldMode, newMode, path: parts[i + 1] });
  }
  return out;
}

/** HEAD's first-parent chain, HEAD first, MAX_DISTANCE ancestors at most. */
export function firstParentChain(root, sha, max = MAX_DISTANCE) {
  const r = gitRaw(root, ["rev-list", "--first-parent", `--max-count=${max + 1}`, sha]);
  return r.ok ? r.out.split(/\r?\n/).filter(Boolean) : [];
}

const treeOf = (root, sha) => { const r = gitRaw(root, ["rev-parse", "--verify", "--quiet", `${sha}^{tree}`]); return r.ok ? r.out.trim() : null; };

/** A record that is a REAL heavy pass for `sha` (written by a green heavy run or a verified attest, never a carry). */
export const isRealHeavyPass = (rec, sha) => Boolean(rec && rec.sha === sha && rec.via !== "carry");

/**
 * Can `sha` carry a heavy pass? With `from` (check time) the origin is the record's claim; without it (`gate-cli carry`)
 * it is the nearest real heavy record on the first-parent chain.
 * @param {{readStamp:(root:string, sha:string)=>object|null, from?:string}} o
 * @returns {{ok:true, from:string, fromTree:string, originAt:string, originWho?:string, originVia?:string, paths:string[], configKeys:string[]} | {ok:false, code:string, reason:string}}
 */
export function carryEligibility(root, sha, { readStamp, from } = {}) {
  const head = configAt(root, sha);
  if (head.error) return refuse("disabled", head.error);
  const carry = normalizeHeavyCarry(head.cfg);
  if (!carry) return refuse("disabled", `gate.heavyCarryOver is not enabled in ${short(sha)}'s committed ${CONFIG_FILE}`);

  const chain = firstParentChain(root, sha);
  if (!chain.length || chain[0] !== sha) return refuse("not-first-parent", `cannot walk ${short(sha)}'s history`);
  let origin = from;
  if (origin === undefined) {
    origin = chain.slice(1).find((s) => isRealHeavyPass(readStamp(root, s), s));
    if (!origin) return refuse("no-origin", `no commit within ${MAX_DISTANCE} first-parent commits of ${short(sha)} has a real green heavy run to carry from`);
  } else if (typeof origin !== "string" || !/^[0-9a-f]{40}$/.test(origin) || !chain.slice(1).includes(origin)) {
    return refuse("not-first-parent", `carriedFrom ${short(origin)} is not a first-parent ancestor of ${short(sha)} within ${MAX_DISTANCE} commits`);
  }

  const rec = readStamp(root, origin);
  if (!rec || rec.sha !== origin) return refuse("origin-invalid", `the origin ${short(origin)} has no heavy record for exactly that commit`);
  if (rec.via === "carry") return refuse("origin-is-carry", `the origin ${short(origin)}'s record is itself a carry: carries are evaluated only against a real heavy run`);
  const fromTree = treeOf(root, origin);
  if (!fromTree || (rec.tree && rec.tree !== fromTree)) return refuse("origin-invalid", `the origin ${short(origin)}'s record names tree ${short(rec.tree)}, the commit's tree is ${short(fromTree)}`);

  const before = configAt(root, origin);
  if (before.error) return refuse("config-keys", before.error);
  if (canon(before.cfg?.gate ?? null) !== canon(head.cfg?.gate ?? null)) return refuse("carry-config-changed", `the gate block (heavy carry-over's own rules) changed since ${short(origin)}: a real heavy run must contain that change`);

  const entries = rawDiff(root, origin, sha);
  const d = judgeEntries(entries, carry.paths);
  if (!d.ok) return refuse("diff", `${d.refused.length} of ${entries.length} changed path(s) since ${short(origin)} cannot carry: ${d.refused.map((x) => `${x.path} (${x.reason})`).join("; ")}`, { refused: d.refused });

  let configKeys = [];
  if (d.paths.includes(CONFIG_FILE)) {
    let j;
    try { j = judgeConfigChange(before.cfg, head.cfg, carry.configKeys); } catch (e) { return refuse("config-keys", `gate.heavyCarryOver.configKeys is invalid: ${e.message}`); }
    if (!j.ok) return refuse("config-keys", `${CONFIG_FILE} changed outside the carry-able keys since ${short(origin)}: ${j.refused.map((x) => `${x.key} (${x.reason})`).join("; ")}`, { refused: j.refused });
    configKeys = j.changed;
  }
  return { ok: true, from: origin, fromTree, originAt: rec.at, originWho: rec.who, originVia: rec.via, paths: d.paths, configKeys };
}

/** Re-verify a stored carry record. Only `carriedFrom` is read from it; paths/keys are recomputed. */
export function verifyCarryRecord(root, sha, rec, { readStamp }) {
  if (!rec || rec.via !== "carry" || rec.sha !== sha) return refuse("origin-invalid", "not a carry record for this commit");
  return carryEligibility(root, sha, { readStamp, from: rec.carriedFrom });
}
