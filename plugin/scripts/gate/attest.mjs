/**
 * attest.mjs - `gate-cli attest` (D073): import a tier pass that was verified on the office PC's CI runner
 * (OfficeCI) instead of locally. The second, verified way to produce a heavy stamp / a standard predeploy stamp;
 * hand-writing either stays blocked by the predeploy-guard.
 *
 * Every check must hold or nothing is written (exit 1, one clear reason):
 *   1. the coordinator reports the job finished and passed with exit code 0
 *   2. the job ran on the same origin repo as the target repo
 *   3. the log carries the tier's own success marker (heavy: HEAVY_MARKER; predeploy: "STAMP ISSUED" and zero
 *      blocking findings) - never --live (that always runs locally)
 *   4. the log carries `officeci-sha <full sha>` equal to --sha, and --sha resolves in this repo; an optional
 *      `officeci-tree <tree>` line must equal --sha's local tree
 * Heavy writes the heavy-pass record (writeHeavyStamp) and pays the debt it covers, exactly like a local green
 * run; predeploy writes the stamp shape run.mjs writes, 72h (stampTtlHours) from the JOB'S finish time. Both carry
 * who=officeci:<job> and via=attest.
 *
 * The URL: OFFICECI_URL, else Credential Manager `officeci-url`, else `officeci.url` in maple.config.json. OFFICECI_TOKEN comes from the environment, else Windows Credential Manager (credential-manager
 * skill pattern; target officeci-attest, else officeci-owner). The token is only ever put in an Authorization header.
 * Coordinator shapes (officeci server.js): GET /api/jobs/<id> = {state, exitCode, repo, attempts, updatedAt(ms), ...};
 * the log is the SSE stream /api/jobs/<id>/stream (`event: log` chunks {seq,text}, ends with `event: end`).
 */
import { spawnSync } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { git, payDebt, resolveSha, writeHeavyStamp } from "./gate-state.mjs";
import { loadMapleConfig } from "../predeploy/lib.mjs";

export const HEAVY_MARKER = "heavy passed - fast + gate additions + live RLS/pgTAP + audits green.";
export const CRED_TARGETS = ["officeci-attest", "officeci-owner"]; // least-privilege token first
export const KINDS = ["heavy", "predeploy"];

export class AttestError extends Error {}
const fail = (msg) => { throw new AttestError(msg); };

/** git@host:o/r.git, ssh://git@host/o/r, https://user@host/o/r.git/ -> host/o/r (lower case). */
export function normalizeRepoUrl(u) {
  let s = String(u ?? "").trim().replace(/\.git\/?$/i, "").replace(/\/+$/, "");
  s = s.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "").replace(/^([^/:]+):(?!\d+\/)/, "$1/");
  return s.toLowerCase();
}

/** Windows Credential Manager, read just-in-time; the value goes nowhere but the return value. */
export function credentialFromStore(targets = CRED_TARGETS, run = spawnSync) {
  if (process.platform !== "win32") return null;
  for (const t of targets) { const v = readTarget(t, run); if (v) return v; }
  return null;
}

function readTarget(target, run) {
  const ps = `$c = Get-StoredCredential -Target '${target}' -ErrorAction SilentlyContinue; if ($c) { [Console]::Out.Write($c.GetNetworkCredential().Password) }`;
  const r = run("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true });
  return r.status === 0 && r.stdout ? r.stdout : null;
}

export const URL_CRED_TARGETS = ["officeci-url"]; // the password field holds the coordinator URL (not a secret, kept beside the token)

/**
 * Coordinator URL, first hit wins: the real process OFFICECI_URL; Windows Credential Manager target `officeci-url`;
 * `officeci.url` in the target repo's maple.config.json (committed, reviewable). There is no command-line source, and the
 * guard denies an inline OFFICECI_URL= on an attest command. Must be http(s).
 */
export function coordinatorUrl(root, env = process.env, urlStore = () => credentialFromStore(URL_CRED_TARGETS)) {
  const raw = env.OFFICECI_URL || urlStore() || loadMapleConfig(root)?.officeci?.url || "";
  const url = String(raw).trim().replace(/\/+$/, "");
  if (!url) fail("no coordinator URL: set OFFICECI_URL, Credential Manager target 'officeci-url', or officeci.url in maple.config.json");
  if (!/^https?:\/\/[^\s/]+/i.test(url)) fail("the coordinator URL is not an http(s) URL");
  return url;
}

export function resolveCoordinator(root, env = process.env, store = credentialFromStore, urlStore) {
  const url = coordinatorUrl(root, env, urlStore);
  const token = env.OFFICECI_TOKEN || store();
  if (!token) fail(`OFFICECI_TOKEN is not set and Credential Manager has no '${CRED_TARGETS.join("' or '")}' entry`);
  return { url, token };
}

async function get(fetchImpl, url, token, what) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    fail(`cannot reach the OfficeCI coordinator for ${what}: ${e.message}`);
  }
  if (!res.ok) fail(`OfficeCI ${what} answered HTTP ${res.status}`);
  return res;
}

/** Job metadata + log from the coordinator. */
export async function fetchJob({ url, token }, id, fetchImpl = fetch) {
  const enc = encodeURIComponent(id);
  let job;
  try { job = await (await get(fetchImpl, `${url}/api/jobs/${enc}`, token, `job ${id}`)).json(); }
  catch (e) { if (e instanceof AttestError) throw e; fail(`job ${id}: the coordinator did not return JSON`); }
  const sse = await (await get(fetchImpl, `${url}/api/jobs/${enc}/stream`, token, `log of job ${id}`)).text();
  return { job, log: parseSseLog(sse) };
}

/** Concatenate the `event: log` chunks of an SSE replay in seq order. A stream with no `event: end` was cut short. */
export function parseSseLog(sse) {
  const chunks = [];
  let ended = false;
  for (const block of String(sse).split(/\r?\n\r?\n/)) {
    const ev = /^event:\s*(\S+)/m.exec(block)?.[1];
    if (ev === "end") ended = true;
    if (ev !== "log") continue;
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    try { const c = JSON.parse(data); chunks.push(c); } catch { fail("job log stream held an unreadable chunk"); }
  }
  if (!ended) fail("job log stream ended without an `end` event (log may be incomplete)");
  return chunks.sort((a, b) => a.seq - b.seq).map((c) => String(c.text ?? "")).join("");
}

/**
 * Pure verification of a fetched job against the target. Returns the facts the stamp needs.
 * @returns {{finishedAt:string}} or throws AttestError
 */
export function verifyJob({ job, log, kind, sha, originUrl, tree }) {
  if (!job || typeof job !== "object") fail("the coordinator returned no job");
  if (job.state !== "passed") fail(`job did not pass (state: ${job.state ?? "unknown"})`);
  if (job.exitCode !== 0) fail(`job exit code is ${job.exitCode ?? "unknown"}, not 0`);
  if (job.attempts !== 1) fail(`job ran ${job.attempts ?? "an unknown number of"} attempts (a retry re-fetches the ref, so its log is not one commit); re-run it`);
  const jobRepo = normalizeRepoUrl(job.repo);
  if (!jobRepo) fail("job does not name the repo it ran on");
  if (jobRepo !== normalizeRepoUrl(originUrl)) fail(`job ran on repo '${jobRepo}', this repo's origin is '${normalizeRepoUrl(originUrl)}'`);
  const finished = job.updatedAt; // a finished job's last update (the coordinator has no finishedAt); epoch ms
  if (!Number.isFinite(finished) || finished <= 0) fail("job has no valid finish time (updatedAt)");
  const text = String(log ?? "");
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (kind === "heavy") {
    if (!lines.includes(HEAVY_MARKER)) fail(`log lacks the heavy success line "${HEAVY_MARKER}"`);
  } else {
    if (!lines.some((l) => /^STAMP ISSUED for [0-9a-f]{8}\b/.test(l))) fail('log lacks the predeploy gate\'s "STAMP ISSUED" line');
    if (lines.some((l) => /^GATE FAILED\b/.test(l))) fail("log shows GATE FAILED");
    if (/--live\b/.test(job.command ?? "")) fail("a --live run is never imported; --live always runs locally");
    if (job.command && /--(allow-dirty|check)\b/.test(job.command)) fail("a partial (--check / --allow-dirty) predeploy run is not a gate pass");
    const blocking = lines.filter((l) => /\bblocking=(\d+)/.test(l)).some((l) => Number(/\bblocking=(\d+)/.exec(l)[1]) > 0);
    if (blocking) fail("log shows blocking findings");
    if (!lines.some((l) => /\bblocking=0\b/.test(l))) fail("log shows no per-check result lines (cannot confirm zero findings)");
  }
  const shaLines = lines.map((l) => /^officeci-sha ([0-9a-f]{40})$/.exec(l)?.[1]).filter(Boolean);
  if (!shaLines.length) fail('log lacks an "officeci-sha <full sha>" line');
  if (new Set(shaLines).size > 1 || shaLines[0] !== sha) fail(`log's officeci-sha (${shaLines[0].slice(0, 10)}) is not ${sha.slice(0, 10)}`);
  const treeLine = lines.map((l) => /^officeci-tree ([0-9a-f]{40})$/.exec(l)?.[1]).find(Boolean);
  if (treeLine && treeLine !== tree) fail(`log's officeci-tree (${treeLine.slice(0, 10)}) does not match ${sha.slice(0, 10)}'s tree (${String(tree).slice(0, 10)})`);
  return { finishedAt: new Date(finished).toISOString() };
}

/** Same document run.mjs writes on a green gate, bound to THIS checkout's config/allowlist/decisions hashes. */
async function writePredeployStamp(root, sha, tree, jobId, finishedAt) {
  const P = (f) => import(new URL(`../predeploy/${f}`, import.meta.url).href);
  const [{ configHash, normalize }, al, dec, idm, lib, st] = await Promise.all([P("config.mjs"), P("allowlist.mjs"), P("decisions.mjs"), P("imagedebt.mjs"), P("lib.mjs"), P("state.mjs")]);
  const pd = normalize(lib.loadMapleConfig(root));
  if (!pd || pd.enabled === false) fail("predeploy gate is not enabled for this project");
  if (lib.headSha(root) !== sha) fail("predeploy attest needs --sha to be HEAD of this checkout (the stamp is bound to its config)");
  if (lib.trackedDirty(root)) fail("tracked files differ from HEAD");
  const list = al.loadAllowlist(root, pd.allowlist);
  const decisions = dec.loadDecisions(root, pd.decisions);
  const idl = pd.imageDebt ? idm.loadImageDebt(root, pd.imageDebt.file) : null;
  const rec = {
    version: lib.GATE_VERSION, status: "pass", sha, tree,
    issuedAt: finishedAt, expiresAt: new Date(Date.parse(finishedAt) + pd.stampTtlHours * 3600000).toISOString(),
    configHash: configHash(pd), allowlistHash: al.allowlistHash(list), decisionsHash: dec.decisionsHash(decisions),
    ...(idl ? { imageDebtHash: idm.imageDebtHash(idl) } : {}),
    checks: [], remote: [], by: `officeci:${jobId}`, who: `officeci:${jobId}`, via: "attest",
  };
  const target = st.stampPath(root, sha);
  const tmp = target + `.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
  renameSync(tmp, target);
  return rec;
}

/**
 * @param {{kind?:string, sha:string, job:string, root:string, env?:object, fetchImpl?:Function, store?:Function, urlStore?:Function}} o
 * @returns {Promise<string>} human line for stdout; throws AttestError when nothing was written
 */
export async function attest({ kind = "heavy", sha: shaArg, job: jobId, root, env = process.env, fetchImpl = fetch, store, urlStore }) {
  if (!KINDS.includes(kind)) fail(`--kind must be one of ${KINDS.join(", ")} (never live: --live always runs locally)`);
  if (typeof jobId !== "string" || !jobId) fail("--officeci-job is required");
  if (typeof shaArg !== "string" || !shaArg) fail("--sha is required");
  const sha = resolveSha(root, shaArg);
  if (!sha) fail(`--sha ${shaArg} is not a commit in this repo`);
  const tree = git(root, ["rev-parse", `${sha}^{tree}`]);
  const originUrl = git(root, ["remote", "get-url", "origin"]);
  if (!originUrl) fail("this repo has no 'origin' remote to compare the job's repo against");
  const { job, log } = await fetchJob(resolveCoordinator(root, env, store, urlStore), jobId, fetchImpl);
  const { finishedAt } = verifyJob({ job, log, kind, sha, originUrl, tree });
  const who = `officeci:${jobId}`;
  if (kind === "heavy") {
    writeHeavyStamp(root, sha, { who, via: "attest" });
    const settled = payDebt(root, sha);
    return `heavy pass attested for ${sha.slice(0, 10)} from OfficeCI job ${jobId}${settled.length ? `; paid ${settled.length} gate debt entr${settled.length === 1 ? "y" : "ies"}` : ""}`;
  }
  const rec = await writePredeployStamp(root, sha, tree, jobId, finishedAt);
  return `predeploy stamp attested for ${sha.slice(0, 10)} from OfficeCI job ${jobId} (expires ${rec.expiresAt})`;
}

