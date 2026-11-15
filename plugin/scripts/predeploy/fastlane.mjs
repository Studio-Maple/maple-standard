/**
 * fastlane.mjs - the FAST LANE: deploy first, enforce after. Off unless `predeploy.fastLane.enabled` is true.
 *
 * State, under <git-common-dir>/maple/predeploy/fast-lane (guarded like every other gate state, never committed):
 *   permit.json   "HEAD <sha> may deploy ahead of its heavy + predeploy run", written only by `fastlane-cli.mjs permit`
 *   debt.jsonl    append-only: one `debt` line per fast deploy {id, sha, base, at, deadline, permitExpiresAt, who} and
 *                 one `closed` line when it is paid (heavy + predeploy stamps) or the release is rolled back
 *
 * The lane moves the expensive verification AFTER the deploy; it never removes it:
 *   before  - the gate tier green on this tree, tree clean, commit pushed, no unpaid gate debt, a secret scan of the
 *             diff, and a proof from the diff that every changed path is eligible (fastlane-rules.mjs)
 *   deploy  - the guard records ONE debt: heavy + predeploy are owed on that commit within the deadline
 *   after   - while the debt is open every other production deploy is refused, except a fully stamped commit that
 *             contains the indebted one (which pays it) or a rollback to the debt's fully stamped base
 * Past the deadline nothing is rolled back automatically: deploys stay blocked and the two ways out are printed.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { normalize } from "./config.mjs";
import { classify, normalizeFastLane, rulesHash } from "./fastlane-rules.mjs";
import { git, headSha, loadMapleConfig, stateDir, trackedDirty, which } from "./lib.mjs";
import { readJson, stampPath, verifyStamp, writeJson } from "./state.mjs";
import { isAncestorOrSame, readHeavyStamp, sub as gateSub, unpaidDebt, who } from "../gate/gate-state.mjs";

const short = (s) => String(s || "").slice(0, 8);
const iso = (d) => new Date(d).toISOString();

export function flDir(root) {
  const d = join(stateDir(root), "fast-lane");
  mkdirSync(d, { recursive: true });
  return d;
}
export const permitFile = (root) => join(flDir(root), "permit.json");
const debtFile = (root) => join(flDir(root), "debt.jsonl");

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ── stamps ──────────────────────────────────────────────────────────────────
const predeployPass = (root, sha) => { const s = readJson(stampPath(root, sha)); return Boolean(s && s.status === "pass" && s.sha === sha); };
const heavyPass = (root, sha) => readHeavyStamp(root, sha)?.sha === sha;
/** A green heavy run AND a predeploy pass were recorded for exactly this commit. */
export const fullyStamped = (root, sha) => heavyPass(root, sha) && predeployPass(root, sha);

/** Nearest fully stamped commit in `head`'s history (the proven baseline the diff is taken from), else null. */
export function fastLaneBase(root, head) {
  const out = git(root, ["rev-list", "--max-count=2000", head]);
  if (!out) return null;
  for (const sha of out.split(/\r?\n/)) if (fullyStamped(root, sha)) return sha;
  return null;
}

const stampedShas = (dir) => { try { return readdirSync(dir).filter((f) => /^[0-9a-f]{40}\.json$/.test(f)).map((f) => f.slice(0, 40)); } catch { return []; } };

/** Which stamps pay a debt: each may sit on the indebted commit or any descendant (the rule gate debt's payDebt uses). */
export function debtPayment(root, debt) {
  const covers = (s) => isAncestorOrSame(root, debt.sha, s);
  const heavy = stampedShas(gateSub(root, "heavy-pass")).find((s) => heavyPass(root, s) && covers(s)) || null;
  const predeploy = stampedShas(dirname(stampPath(root, debt.sha))).find((s) => predeployPass(root, s) && covers(s)) || null;
  return { heavy, predeploy, owes: [...(heavy ? [] : ["heavy"]), ...(predeploy ? [] : ["predeploy"])] };
}

// ── debt ledger ─────────────────────────────────────────────────────────────
export function readDebts(root) {
  const lines = readLines(debtFile(root));
  const closed = new Map(lines.filter((l) => l.type === "closed").map((l) => [l.of, l]));
  return lines.filter((l) => l.type === "debt").map((d) => ({ ...d, closed: closed.get(d.id) || null }));
}

function closeDebt(root, debt, how, extra, now) {
  const rec = { type: "closed", of: debt.id, how, sha: debt.sha, ...extra, at: iso(now) };
  appendFileSync(debtFile(root), JSON.stringify(rec) + "\n");
  return rec;
}

/** The one unpaid debt, after settling it if its stamps have arrived. @returns {object|null} */
export function openDebt(root, now = new Date()) {
  const debt = readDebts(root).find((d) => !d.closed);
  if (!debt) return null;
  const pay = debtPayment(root, debt);
  if (pay.owes.length === 0) { closeDebt(root, debt, "paid", { heavy: pay.heavy, predeploy: pay.predeploy }, now); return null; }
  return { ...debt, owes: pay.owes, overdue: now > new Date(debt.deadline) };
}

function recordDebt(root, { sha, base, deadlineHours, permitExpiresAt }, now) {
  if (readDebts(root).some((d) => !d.closed)) throw new Error("a fast-lane debt is already open");
  const rec = { type: "debt", id: `${short(sha)}-${now.getTime()}`, sha, base, at: iso(now), deadline: iso(now.getTime() + deadlineHours * 3600000), permitExpiresAt, who: who() };
  appendFileSync(debtFile(root), JSON.stringify(rec) + "\n");
  return rec;
}

const lastRollback = (root) => readDebts(root).filter((d) => d.closed?.how === "rolled-back").pop() || null;

// ── eligibility ─────────────────────────────────────────────────────────────
/** Changed paths between two commits; renames are reported as a delete + an add so BOTH names are judged. */
export function changedEntries(root, base, head) {
  const r = spawnSync("git", ["diff", "--raw", "--no-renames", "--no-abbrev", "-z", base, head], { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("git diff failed: " + (r.stderr || "").trim());
  const parts = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [oldMode, newMode] = parts[i].replace(/^:/, "").split(" ");
    const special = [oldMode, newMode].includes("160000") ? "submodule pointer change" : [oldMode, newMode].includes("120000") ? "symbolic link" : undefined;
    out.push({ path: parts[i + 1], ...(special ? { special } : {}) });
  }
  return out;
}

/** @returns {{ok:boolean, reason?:string, base?:string, files?:number, denied?:object[]}} */
export function eligibility(root, pd, fl, sha) {
  const base = fastLaneBase(root, sha);
  if (!base) return { ok: false, reason: "no fully stamped commit (green heavy run + predeploy pass) in HEAD's history to prove the diff against - the first release takes the full path" };
  if (base === sha) return { ok: false, base, reason: "HEAD is already fully stamped - nothing to fast-lane" };
  const entries = changedEntries(root, base, sha);
  const c = classify(entries, pd, fl);
  if (!c.eligible) return { ok: false, base, files: entries.length, denied: c.denied, reason: `${c.denied.length} of ${entries.length} changed path(s) since ${short(base)} may not take the fast lane` };
  return { ok: true, base, files: entries.length };
}

// ── pre-deploy conditions (each injectable for tests) ───────────────────────
function commonDir(root) {
  const c = git(root, ["rev-parse", "--git-common-dir"]);
  return c ? (isAbsolute(c) ? c : resolve(root, c)) : null;
}

/** A tree-bound pass stamp of the project's gate tier (prepush-lib.sh `pp_stamp_write`) exists for this commit's tree. */
export function gateStampFor(root, sha, tiers) {
  const tree = git(root, ["rev-parse", `${sha}^{tree}`]);
  const dir = commonDir(root);
  if (!tree || !dir) return null;
  return tiers.find((t) => existsSync(join(dir, "ci-gate-pass", `${t}-${tree}`))) || null;
}

/** The commit is on a remote-tracking branch (as of the last fetch/push - no network call). */
export function isPushed(root, sha) {
  const out = git(root, ["branch", "-r", "--contains", sha]);
  return Boolean(out && out.trim());
}

/** gitleaks over the commits base..head. Fails CLOSED: a missing scanner or an unreadable report is not a pass. */
export function secretScan(root, base, head) {
  if (!which("gitleaks")) return { ok: false, reason: "gitleaks is not installed - the fast lane needs a secret scan of the diff" };
  const report = join(tmpdir(), `fastlane-gitleaks-${process.pid}-${Date.now()}.json`);
  const cfg = existsSync(join(root, ".gitleaks.toml")) ? ["--config", ".gitleaks.toml"] : [];
  const r = spawnSync("gitleaks", ["detect", "--source", ".", `--log-opts=${base}..${head}`, "--redact", "--ignore-gitleaks-allow", ...cfg, "--exit-code", "0", "--report-format", "json", "--report-path", report], { cwd: root, encoding: "utf8", timeout: 300000 });
  try {
    if (r.status !== 0 || r.error) return { ok: false, reason: "gitleaks did not complete: " + ((r.stderr || r.error?.message || "").trim().split(/\r?\n/).pop() || "unknown error") };
    const found = JSON.parse(readFileSync(report, "utf8"));
    if (!Array.isArray(found)) return { ok: false, reason: "gitleaks report is unreadable" };
    if (found.length) return { ok: false, reason: `${found.length} secret finding(s) in the diff (first: ${found[0].RuleID} in ${found[0].File}) - the fast lane takes zero findings and no allowlist` };
    return { ok: true, reason: "no secrets in the diff" };
  } catch (e) {
    return { ok: false, reason: "gitleaks report is unreadable: " + e.message };
  } finally {
    rmSync(report, { force: true });
  }
}

// ── permit ──────────────────────────────────────────────────────────────────
function context(root) {
  const pd = normalize(loadMapleConfig(root));
  return { pd, fl: pd && pd.enabled !== false ? normalizeFastLane(pd) : null };
}

/**
 * Judge HEAD for the fast lane. `write: true` issues the permit when every condition holds.
 * @returns {{ok:boolean, sha?:string, base?:string, files?:number, failures:string[], denied:object[], permit?:object}}
 */
export function permit(root, { write = true, now = new Date(), deps = {} } = {}) {
  const { pd, fl } = context(root);
  if (!fl) return { ok: false, failures: ["the fast lane is not enabled for this project (predeploy.fastLane.enabled)"], denied: [] };
  const sha = headSha(root);
  if (!sha) return { ok: false, failures: ["cannot determine HEAD"], denied: [] };
  const failures = [];
  const debt = openDebt(root, now);
  if (debt) failures.push(`a fast-lane debt is already open on ${short(debt.sha)} (${debt.overdue ? "OVERDUE since" : "due"} ${debt.deadline}; owes ${debt.owes.join(" + ")}) - only one at a time`);
  if (trackedDirty(root)) failures.push("tracked files differ from HEAD - commit first");
  if (!(deps.isPushed ?? isPushed)(root, sha)) failures.push(`HEAD ${short(sha)} is not on any remote branch - push it first`);
  if (!(deps.gateStampFor ?? gateStampFor)(root, sha, fl.gateTiers)) failures.push(`no green gate-tier pass stamp (${fl.gateTiers.join(" | ")}) for this tree - run the project's gate tier on this commit`);
  const gd = unpaidDebt(root, { head: sha });
  if (gd.length) failures.push(`${gd.length} unpaid gate debt entr${gd.length === 1 ? "y" : "ies"} in HEAD's history (first: step ${gd[0].step}, ${gd[0].reason}) - a skipped gate step is not a green gate`);
  let el = { ok: false, reason: "not evaluated" };
  try { el = eligibility(root, pd, fl, sha); } catch (e) { el = { ok: false, reason: e.message }; }
  if (!el.ok) failures.push(el.reason);
  // The scan is the only slow step: skip it once the lane is already refused.
  if (!failures.length) { const s = (deps.secretScan ?? secretScan)(root, el.base, sha); if (!s.ok) failures.push(s.reason); }
  const res = { ok: failures.length === 0, sha, base: el.base, files: el.files, failures, denied: el.denied || [] };
  if (!res.ok || !write) return res;
  res.permit = { sha, base: el.base, tree: git(root, ["rev-parse", `${sha}^{tree}`]), files: el.files, rulesHash: rulesHash(pd, fl), at: iso(now), expiresAt: iso(now.getTime() + fl.permitMinutes * 60000), deadlineHours: fl.deadlineHours, who: who() };
  writeJson(permitFile(root), res.permit);
  return res;
}

/** A permit that still stands for `sha`: unexpired, same rules, and the diff still proves eligible. */
function permitFor(root, pd, fl, sha, now) {
  const p = readJson(permitFile(root));
  if (!p || p.sha !== sha) return { reason: `no fast-lane permit for HEAD ${short(sha)}` };
  if (now > new Date(p.expiresAt)) return { reason: `the fast-lane permit for ${short(sha)} expired ${p.expiresAt}` };
  if (p.rulesHash !== rulesHash(pd, fl)) return { reason: "the fast-lane rules changed since the permit was issued" };
  if (trackedDirty(root)) return { reason: "tracked files differ from HEAD - the permit covers the committed tree only" };
  let el;
  try { el = eligibility(root, pd, fl, sha); } catch (e) { el = { ok: false, reason: e.message }; }
  if (!el.ok || el.base !== p.base) return { reason: `the diff no longer proves eligible (${el.reason || "the stamped base moved"})` };
  return { permit: p };
}

// ── the deploy decision (guard hook + verify.mjs) ───────────────────────────
const wayOut = (d) =>
  `  Two ways out:\n` +
  `    1. FIX FORWARD: get a green heavy run AND a predeploy stamp on ${short(d.sha)} or a commit that contains it (that pays the debt; a fully stamped descendant may also be deployed).\n` +
  `    2. ROLL BACK: check out ${short(d.base)} (the last fully stamped commit) and deploy it.`;

function debtDenial(d, sha, why) {
  const head = d.overdue
    ? `FAST-LANE DEBT OVERDUE: ${short(d.sha)} was deployed ahead of its full verification at ${d.at} and the deadline ${d.deadline} HAS PASSED. Production is running a commit that still owes ${d.owes.join(" + ")}`
    : `a fast-lane debt is open: ${short(d.sha)} was deployed ahead of its full verification and still owes ${d.owes.join(" + ")} by ${d.deadline}`;
  return `${head}. HEAD ${short(sha)} may not deploy: ${why}.\n${wayOut(d)}`;
}

/**
 * Everything `verifyStamp` decides, plus the fast lane. Read-only apart from settling a debt whose stamps exist;
 * the caller that actually lets a deploy through must call `applyDeploy` with the result.
 * @returns {{ok:boolean, reason:string, sha?:string, lane:"full"|"fast"|"rollback"|"emergency"|"none", action?:string, debt?:object, permit?:object, emergency?:object}}
 */
export function verifyDeploy(root, { now = new Date() } = {}) {
  const full = verifyStamp(root);
  const { pd, fl } = context(root);
  if (!pd || pd.enabled === false) return { ...full, lane: "full" };
  const sha = full.sha || headSha(root);
  if (!sha) return { ...full, lane: "none" };
  if (full.emergency) return { ...full, lane: "emergency" };

  const debt = openDebt(root, now);
  if (debt) {
    if (sha === debt.base) {
      if (!fullyStamped(root, sha)) return { ok: false, sha, lane: "none", debt, reason: debtDenial(debt, sha, "the rollback target has lost its stamps") };
      if (trackedDirty(root)) return { ok: false, sha, lane: "none", debt, reason: debtDenial(debt, sha, "tracked files differ from the rollback commit") };
      return { ok: true, sha, lane: "rollback", action: "close-rollback", debt, reason: `ROLLBACK to ${short(sha)}, the fully stamped base of the open fast-lane debt on ${short(debt.sha)}; the debt closes as rolled back` };
    }
    if (sha === debt.sha) {
      if (debt.overdue) return { ok: false, sha, lane: "none", debt, reason: debtDenial(debt, sha, "it is the indebted commit and its deadline has passed") };
      if (now > new Date(debt.permitExpiresAt)) return { ok: false, sha, lane: "none", debt, reason: debtDenial(debt, sha, `the deploy window for this commit closed ${debt.permitExpiresAt}`) };
      if (trackedDirty(root)) return { ok: false, sha, lane: "none", debt, reason: debtDenial(debt, sha, "tracked files differ from HEAD") };
      return { ok: true, sha, lane: "fast", debt, reason: `fast lane: continuing the deploy of ${short(sha)} (full heavy + predeploy owed by ${debt.deadline})` };
    }
    const why = full.ok ? "it does not contain the indebted commit" : isAncestorOrSame(root, debt.sha, sha) ? `it is not fully stamped (${full.reason})` : "it neither contains the indebted commit with full stamps nor is the rollback target";
    return { ok: false, sha, lane: "none", debt, reason: debtDenial(debt, sha, why) };
  }

  if (full.ok) return { ...full, lane: "full" };
  const rb = lastRollback(root);
  if (rb && rb.base === sha && now - new Date(rb.closed.at) < (fl?.permitMinutes ?? 60) * 60000 && fullyStamped(root, sha) && !trackedDirty(root)) {
    return { ok: true, sha, lane: "rollback", reason: `continuing the rollback to ${short(sha)}` };
  }
  if (!fl) return { ...full, lane: "none" };
  const p = permitFor(root, pd, fl, sha, now);
  if (!p.permit) return { ...full, lane: "none", reason: `${full.reason}. Fast lane: ${p.reason} - \`node <plugin>/scripts/predeploy/fastlane-cli.mjs permit\` says whether this change qualifies` };
  return { ok: true, sha, lane: "fast", action: "record-debt", permit: p.permit, reason: `FAST LANE: ${short(sha)} deploys ahead of its full verification (${p.permit.files} eligible path(s) since ${short(p.permit.base)}); full heavy + predeploy are owed on it within ${p.permit.deadlineHours}h` };
}

/** Persist what an allowed deploy changes. Throws when it cannot: the caller must then refuse the deploy. */
export function applyDeploy(root, v, { now = new Date() } = {}) {
  if (v.action === "record-debt") {
    const rec = recordDebt(root, { sha: v.sha, base: v.permit.base, deadlineHours: v.permit.deadlineHours, permitExpiresAt: v.permit.expiresAt }, now);
    rmSync(permitFile(root), { force: true }); // spent: the debt carries the deploy window from here on
    return rec;
  }
  if (v.action === "close-rollback") return closeDebt(root, v.debt, "rolled-back", { base: v.debt.base }, now);
  return null;
}

// ── status (people and the scheduled runner) ────────────────────────────────
export function status(root, { now = new Date() } = {}) {
  const { pd, fl } = context(root);
  const debt = openDebt(root, now);
  const p = readJson(permitFile(root));
  const out = { enabled: Boolean(fl), state: debt ? (debt.overdue ? "overdue" : "owed") : "clear", debt: null, permit: p && now <= new Date(p.expiresAt) && !debt ? p : null, deadlineHours: fl?.deadlineHours ?? null, predeployEnabled: Boolean(pd && pd.enabled !== false) };
  if (debt) {
    const ms = new Date(debt.deadline) - now;
    out.debt = { sha: debt.sha, base: debt.base, at: debt.at, deadline: debt.deadline, overdue: debt.overdue, owes: debt.owes, minutesLeft: Math.round(ms / 60000) };
    out.action = { run: debt.owes, on: debt.sha, text: `run ${debt.owes.join(" + ")} on ${debt.sha} (or a commit that contains it) now`, rollbackTo: debt.base };
  }
  return out;
}
