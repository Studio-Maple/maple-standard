/**
 * state.mjs — everything the gate persists, all under
 * <git-common-dir>/maple/predeploy (shared by every worktree of the repo,
 * never committed):
 *
 *   stamps/<sha>.json     the pass stamp for one exact commit
 *   reports/<sha>.json    the full machine-readable gate report
 *   deploys.jsonl         ledger of deploy commands the guard allowed
 *   live-scans/<ts>.json  post-deploy live scan records
 *   emergency.json        the (owner-only) one-shot emergency override
 *   emergency.log.jsonl   append-only record of every override ever granted
 *
 * HEAVY PROMOTION (D066): verifyStamp additionally requires <git-common-dir>/maple/heavy-pass/<sha>.json (a green
 * heavy tier on exactly HEAD) and zero unpaid gate debt (gate-state.mjs verifyPromotion).
 *
 * LIVE-SCAN DEBT (the stamp model for the aggressive live scan): a live
 * active scan can only meaningfully run AFTER something is deployed, so it is
 * a post-deploy verification that blocks the NEXT deploy. Every deploy the
 * guard allows is a ledger entry; issuing (or honouring) a stamp requires a
 * clean live scan that started after the latest ledger entry — "deploy debt".
 * Deploying the same stamped SHA in several steps never creates debt against
 * its own stamp.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowlistCommitted, allowlistHash, loadAllowlist } from "./allowlist.mjs";
import { configHash, normalize } from "./config.mjs";
import { decisionsCommitted, decisionsHash, loadDecisions } from "./decisions.mjs";
import { imageDebtCommitted, imageDebtHash, loadImageDebt } from "./imagedebt.mjs";
import { headSha, loadMapleConfig, nowIso, stateDir, trackedDirty } from "./lib.mjs";
import { verifyPromotion } from "../gate/gate-state.mjs";

function sub(root, name) {
  const d = join(stateDir(root), name);
  mkdirSync(d, { recursive: true });
  return d;
}

export const stampPath = (root, sha) => join(sub(root, "stamps"), `${sha}.json`);
export const reportPath = (root, sha) => join(sub(root, "reports"), `${sha}.json`);

export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function writeJson(path, v) {
  writeFileSync(path, JSON.stringify(v, null, 2) + "\n");
}

// ── deploy ledger ───────────────────────────────────────────────────────────
const ledgerFile = (root) => join(stateDir(root), "deploys.jsonl");

export function readLedger(root) {
  const f = ledgerFile(root);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

export function appendLedger(root, entry) {
  const seq = readLedger(root).reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1;
  const rec = { seq, ts: nowIso(), status: "attempted", ...entry };
  appendFileSync(ledgerFile(root), JSON.stringify(rec) + "\n");
  return rec;
}

/** Append an outcome record for the most recent attempt matching sha (+ patternId when given). */
export function recordOutcome(root, { sha, patternId, outcome }) {
  const led = readLedger(root);
  const target = [...led].reverse().find((e) => e.type !== "outcome" && e.sha === sha && (!patternId || e.patternId === patternId) && e.status === "attempted");
  if (!target) return null;
  appendFileSync(ledgerFile(root), JSON.stringify({ seq: led.reduce((m, e) => Math.max(m, e.seq || 0), 0) + 1, ts: nowIso(), type: "outcome", of: target.seq, status: outcome }) + "\n");
  return target;
}

/** Effective status of each deploy attempt after outcome records are folded in. */
export function effectiveDeploys(root) {
  const led = readLedger(root);
  const out = new Map();
  for (const e of led) if (e.type !== "outcome") out.set(e.seq, { ...e });
  for (const e of led) if (e.type === "outcome" && out.has(e.of)) out.get(e.of).status = e.status;
  return [...out.values()];
}

// ── live scans ──────────────────────────────────────────────────────────────
export function liveScans(root) {
  const d = sub(root, "live-scans");
  return readdirSync(d).filter((f) => f.endsWith(".json")).sort().map((f) => readJson(join(d, f))).filter(Boolean);
}

/**
 * Debt = deploys (not marked failed) newer than the last CLEAN live scan's coverage,
 * minus deploys of the stamp's own SHA after the stamp was issued.
 */
export function liveScanDebt(root, pd, { stampSha, stampIssuedAt } = {}) {
  const ls = pd.liveScan;
  if (!ls || ls.enabled === false || ls.requireAfterDeploy === false) return { ok: true, reason: "live scan not required" };
  const scans = liveScans(root);
  if (!scans.length) return { ok: false, reason: "no live scan has ever been recorded — run `predeploy-gate --live` once against the current deployment before the first stamp" };
  const latest = scans[scans.length - 1];
  if (latest.status !== "pass") return { ok: false, reason: `latest live scan (${latest.ts}) failed with ${latest.blocking} blocking finding(s) — fix, redeploy if needed, and re-run \`predeploy-gate --live\`` };
  const covered = latest.coversSeq ?? 0;
  const pending = effectiveDeploys(root).filter((d) => d.status !== "failed" && d.seq > covered && !(stampSha && d.sha === stampSha && stampIssuedAt && d.ts >= stampIssuedAt));
  if (pending.length) return { ok: false, reason: `${pending.length} deploy(s) since the last clean live scan (latest: ${pending[pending.length - 1].sha.slice(0, 8)} ${pending[pending.length - 1].patternId}) — run \`predeploy-gate --live\` against the live deployment first` };
  return { ok: true, reason: `live scan ${latest.ts} clean and covers all deploys` };
}

// ── emergency override ──────────────────────────────────────────────────────
export const emergencyFile = (root) => join(stateDir(root), "emergency.json");

export function emergencyValid(root, pd, sha) {
  if (!pd.emergency?.enabled) return null;
  const e = readJson(emergencyFile(root));
  if (!e || e.sha !== sha || new Date(e.expiresAt) < new Date()) return null;
  return e;
}

// ── verification (used by the hook, the verify CLI and deploy scripts) ──────
/**
 * @returns {{ok:boolean, reason:string, stamp?:object, emergency?:object, sha?:string}}
 */
export function verifyStamp(root) {
  const cfg = loadMapleConfig(root);
  const pd = normalize(cfg);
  if (!pd || pd.enabled === false) return { ok: true, reason: "predeploy gate not enabled for this project" };
  const sha = headSha(root);
  if (!sha) return { ok: false, reason: "cannot determine HEAD (not a git repo?)" };
  const emergency = emergencyValid(root, pd, sha);
  if (emergency) return { ok: true, reason: `EMERGENCY OVERRIDE active for ${sha.slice(0, 8)} until ${emergency.expiresAt} (${emergency.reason})`, emergency, sha };
  const stamp = readJson(stampPath(root, sha));
  if (!stamp) return { ok: false, sha, reason: `no predeploy stamp for HEAD ${sha.slice(0, 8)} — run /predeploy-gate (node <plugin>/scripts/predeploy/run.mjs) on a clean tree at this commit` };
  if (stamp.status !== "pass" || stamp.sha !== sha) return { ok: false, sha, reason: "stamp is not a pass for HEAD" };
  if (new Date(stamp.expiresAt) < new Date()) return { ok: false, sha, reason: `stamp expired ${stamp.expiresAt} — re-run the gate` };
  if (stamp.configHash !== configHash(pd)) return { ok: false, sha, reason: "predeploy config changed since the stamp was issued — re-run the gate" };
  const al = loadAllowlist(root, pd.allowlist);
  if (stamp.allowlistHash !== allowlistHash(al)) return { ok: false, sha, reason: "allowlist changed since the stamp was issued — re-run the gate" };
  const dl = loadDecisions(root, pd.decisions);
  if (stamp.decisionsHash !== decisionsHash(dl)) return { ok: false, sha, reason: "decision-backed exceptions changed since the stamp was issued — re-run the gate" };
  if (pd.imageDebt) {
    const idl = loadImageDebt(root, pd.imageDebt.file);
    if (stamp.imageDebtHash !== imageDebtHash(idl)) return { ok: false, sha, reason: "third-party image debt file changed since the stamp was issued — re-run the gate" };
    if (!imageDebtCommitted(root, idl)) return { ok: false, sha, reason: "third-party image debt file is not committed" };
  }
  if (trackedDirty(root)) return { ok: false, sha, reason: "tracked files differ from HEAD — the stamp covers the committed tree only; commit or stash" };
  if (!allowlistCommitted(root, al)) return { ok: false, sha, reason: "allowlist is not committed" };
  if (!decisionsCommitted(root, dl)) return { ok: false, sha, reason: "decision-backed exceptions file is not committed" };
  const debt = liveScanDebt(root, pd, { stampSha: sha, stampIssuedAt: stamp.issuedAt });
  if (!debt.ok) return { ok: false, sha, reason: debt.reason };
  // D066: promotion also needs a green heavy run (live RLS/E2E, integration suites, Jev audit) on THIS exact commit
  // and zero unpaid gate debt among the commits it contains. No knob: a skipped step is paid for, never forgiven.
  const promo = verifyPromotion(root, sha);
  if (!promo.ok) return { ok: false, sha, reason: promo.reason };
  return { ok: true, sha, stamp, reason: `valid stamp for ${sha.slice(0, 8)} issued ${stamp.issuedAt}, expires ${stamp.expiresAt}; ${promo.reason}` };
}
