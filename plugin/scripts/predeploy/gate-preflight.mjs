/**
 * gate-preflight.mjs — the gate's fast verdicts, run FIRST (seconds), so a run cannot die after 30 minutes on
 * something knowable at the start. Also the shared home of the gate's static exception-file verdicts.
 *
 * It adds no rule of its own: every failure is a verdict the full gate would reach later, computed by the same code.
 *   working tree        trackedDirty (lib.mjs)                       — unless --allow-dirty
 *   exception files     structuralFindings(): validateEntries, validateDecisions (+ ledger), exposureCoverage, the
 *                       three committed checks, and evaluateImageDebt's pin checks (no findings needed)
 *   live-scan debt      liveScanDebt (state.mjs)                     — full runs only, as in the gate
 *   remote leg          candidateOnRemote (remote.mjs): HEAD attached / remote.ref, candidate pushed
 *                       runnerProbe (remote.mjs): a matching self-hosted runner is online (or a green run is reusable)
 *   tools / Docker      resolveTool with the gate's own allowDocker/pull; dockerUsable for checks that drive Docker
 *   credentials         the presets' credential targets (presence only, never the value)
 * Check-scoped failures (tools, credentials, remote) then go through the gate's own severity floor, decision-backed
 * exceptions and allowlist, so a failure the gate would except is not a preflight failure either.
 *
 * NOT judged here (they need the scanners' findings): allowlist-unused, decision-stale, image-debt-growth and
 * image-debt-overdue. The full gate still evaluates them.
 */
import { checkNeeds } from "./catalog.mjs";
import { applyAllowlist, allowlistCommitted, validateEntries } from "./allowlist.mjs";
import { applyDecisions, decisionsCommitted, ledgerDecisionIds, validateDecisions } from "./decisions.mjs";
import { evaluateImageDebt, imageDebtCommitted, trivyPins } from "./imagedebt.mjs";
import { exposureCoverage } from "./exposure-config.mjs";
import { credentialExists } from "./credentials.mjs";
import { sevRank, trackedDirty } from "./lib.mjs";
import { liveScanDebt } from "./state.mjs";
import { candidateOnRemote, ghCli, runnerProbe } from "./remote.mjs";
import { TOOLS, dockerUsable, installHints, resolveTool } from "./tools.mjs";

const NO_LEDGER = { ids: new Set(), error: null, file: "" };

/**
 * The gate's structural (bookkeeping) findings, in the gate's report order. `stale` (decision-stale) and
 * `imageDebtBlocking` need the scanners' findings; the preflight passes the pin-only image-debt verdicts instead.
 */
export function structuralFindings(root, pd, { al, dl, idl, today, stale = [], imageDebtBlocking = [] }) {
  const allCheckIds = [...pd.checks.map((c) => c.id), "live-scan"];
  return [
    ...validateEntries(al, { checkIds: allCheckIds, maxDays: pd.allowlistMaxDays }),
    ...validateDecisions(dl, { checkIds: allCheckIds, maxAgeDays: pd.decisionsMaxAgeDays, today, ledger: dl.entries.length ? ledgerDecisionIds(root) : NO_LEDGER }),
    ...stale,
    ...exposureCoverage(pd, pd.exposure?.optOut?.bundle ? ledgerDecisionIds(root) : { ids: new Set(), error: null }),
    ...imageDebtBlocking,
    ...(!idl || imageDebtCommitted(root, idl) ? [] : [{ check: "image-debt", id: "image-debt-uncommitted", severity: "high", message: "third-party image debt file is untracked or modified - the snapshot and due dates must be committed and reviewed", location: idl.path }]),
    ...(decisionsCommitted(root, dl) ? [] : [{ check: "decisions", id: "decision-uncommitted", severity: "high", message: "decision-backed exceptions file is untracked or modified — permanent exceptions must be committed and reviewed", location: dl.path }]),
    ...(allowlistCommitted(root, al) ? [] : [{ check: "allowlist", id: "allowlist-uncommitted", severity: "high", message: "allowlist file is untracked or modified — exceptions must be committed and reviewed", location: al.path }]),
  ];
}

const F = (check, id, message, location = "") => ({ check, id, severity: "high", message, location });

/** Tool, Docker and credential verdicts for one check (check-scoped findings). */
function environmentFindings(c, pd, { pull, resolve, docker, credExists }) {
  const out = [];
  const { tools, credentials } = checkNeeds(c);
  const allowDocker = c.preset === "snyk" ? false : pd.docker.enabled !== false;
  for (const name of tools) {
    if (!TOOLS[name]) continue; // undeclared tool name: the gate never resolves it
    const t = resolve(name, { allowDocker, pull });
    if (t.mode === "missing") out.push(F(c.id, "tool-missing", `${name}: ${t.reason}. Install: ${installHints(name)}`));
  }
  if (tools.includes("docker") && !docker().ok) out.push(F(c.id, "docker-unreachable", `${c.id} drives Docker and the Docker daemon is not reachable — start Docker Desktop, then re-run`));
  for (const target of credentials) {
    if (c.preset === "supabase-advisors" && process.env.SUPABASE_ACCESS_TOKEN) continue;
    if (!credExists(target)) out.push(F(c.id, "token-missing", `credential "${target}" is not in the credential store (credential-manager skill; name only, never the value)`, target));
  }
  return out;
}

/**
 * @param {object} o
 *   root, pd, sha, selected (checks to run), subset, rebaseline, allowDirty, today, pull, al, dl, idl
 *   seams for tests: gh, resolve, docker, credExists
 * @returns {Promise<{ok:boolean, failures:object[], warnings:string[], notes:string[], ms:number}>}
 */
export async function gatePreflight(o) {
  const t0 = Date.now();
  const { root, pd, sha, selected, subset = false, rebaseline = false, allowDirty = false, today = new Date(), pull = false, al, dl, idl } = o;
  const seams = { gh: o.gh || ghCli, resolve: o.resolve || resolveTool, docker: o.docker || dockerUsable, credExists: o.credExists || credentialExists };
  const global = [];
  const scoped = [];
  const warnings = [];
  const notes = [];

  if (!allowDirty && trackedDirty(root)) global.push(F("git", "working-tree-dirty", "tracked files differ from HEAD — commit first; the gate certifies a commit (--allow-dirty runs without a stamp)"));

  // A rebaseline snapshots the image debt: the exception files and the remote leg are not what it certifies.
  if (!rebaseline) {
    const imageDebtBlocking = pd.imageDebt && idl ? evaluateImageDebt([], idl, { pins: trivyPins(pd), ownImages: pd.imageDebt.ownImages, ranImages: new Set(), today, maxDays: pd.imageDebt.maxDays }).blocking : [];
    global.push(...structuralFindings(root, pd, { al, dl, idl, today, imageDebtBlocking }));
    if (!subset) {
      const debt = liveScanDebt(root, pd);
      if (!debt.ok) global.push(F("live-scan", "live-scan-debt", debt.reason));
    }
    for (const c of selected.filter((x) => x.github)) {
      const pushed = candidateOnRemote(root, pd, sha);
      if (pushed.finding) { scoped.push({ ...pushed.finding, check: c.id }); continue; }
      const probe = await runnerProbe(root, pd, c, sha, { gh: seams.gh });
      if (probe.finding) scoped.push({ ...probe.finding, check: c.id });
      if (probe.warning) warnings.push(probe.warning);
      if (probe.note) notes.push(probe.note);
    }
  }
  for (const c of selected) scoped.push(...environmentFindings(c, pd, { pull, ...seams }));

  // The gate's own filters for check-scoped findings: severity floor, then decision-backed entries, then the allowlist.
  const floor = new Map(pd.checks.map((c) => [c.id, sevRank(c.minSeverity || pd.minSeverity)]));
  const floored = scoped.filter((f) => sevRank(f.severity) >= (floor.get(f.check) ?? 0));
  const decided = applyDecisions(floored, dl, { ranChecks: [], today });
  const { blocking } = applyAllowlist(decided.blocking, al, { ranChecks: [] });
  const failures = [...global, ...blocking];
  return { ok: failures.length === 0, failures, warnings, notes, ms: Date.now() - t0 };
}

/** One line per failure: `[check] id — message`. */
export function preflightLines(pf) {
  const lines = pf.failures.map((f) => `  PREFLIGHT FAIL [${f.check}] ${f.id}${f.location ? " " + f.location : ""} — ${String(f.message).split("\n")[0].slice(0, 220)}`);
  for (const w of pf.warnings) lines.push(`  preflight warning: ${w}`);
  return lines;
}
