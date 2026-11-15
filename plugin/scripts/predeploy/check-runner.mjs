/**
 * check-runner.mjs — runs the selected gate checks `pd.concurrency` at a time and times each one honestly.
 *
 * Every check launches its tool without blocking the event loop (proc.mjs), so the pool really overlaps checks.
 * Each result carries:
 *   startedAt / endedAt  ISO times the check itself started and finished (not when it was queued)
 *   ms                   endedAt - startedAt: the check's own run time
 *   queuedMs             time from the start of the batch until a pool slot picked the check up
 * Results come back in the order of `selected` (the config order), whatever order they finish in.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRESETS, ToolMissing, checkNeeds } from "./catalog.mjs";
import { installHints } from "./tools.mjs";
import { parseOutput } from "./parsers.mjs";
import { runShellAsync } from "./lib.mjs";
import { runRemote } from "./remote.mjs";
import { TRIVY_LOCK, pool } from "./proc.mjs";

export async function runCheck(check, pd, ctx) {
  const t0 = Date.now();
  const res = { id: check.id, kind: check.github ? "github" : check.preset ? "preset:" + check.preset : "command", findings: [], notes: [], meta: undefined, startedAt: new Date(t0).toISOString() };
  try {
    if (check.github) {
      const r = await runRemote(check, pd, ctx);
      Object.assign(res, { findings: r.findings, notes: r.notes || [], meta: r.meta });
    } else if (check.preset && PRESETS[check.preset].run) {
      const r = await PRESETS[check.preset].run(check.options || {}, ctx);
      Object.assign(res, { findings: r.findings, notes: r.notes || [] });
    } else {
      let spec;
      if (check.preset) spec = PRESETS[check.preset].build(check.options || {}, ctx);
      else spec = { command: check.command, parse: check.parse || "exit-code", reports: check.reports || [], cwd: "root", env: check.env };
      for (const f of spec.emptyFiles || []) writeFileSync(join(ctx.outDir, f), /\.ya?ml$/.test(f) ? "{}\n" : "");
      const cwd = spec.cwd === "scan" ? ctx.scanRoot : check.cwd ? join(ctx.root, check.cwd) : ctx.root;
      const out = await runShellAsync(spec.command, { cwd, env: { ...(spec.env || {}), PREDEPLOY_OUT: ctx.outDir, PREDEPLOY_SHA: ctx.sha }, timeoutSec: check.timeoutSec || 1800 });
      res.raw = { status: out.status };
      res.text = out.stdout + "\n" + out.stderr;
      if (out.timedOut) res.findings.push({ id: "timeout", severity: "high", message: `exceeded ${check.timeoutSec || 1800}s`, location: "" });
      else if (out.spawnError) res.findings.push({ id: "spawn-failed", severity: "high", message: out.spawnError, location: "" });
      else if (out.status === 127) res.findings.push({ id: "tool-missing", severity: "high", message: `command not found: ${out.stderr.trim().split(/\r?\n/).pop()}`, location: "" });
      else {
        res.findings = parseOutput(spec.parse, {
          status: out.status, stdout: out.stdout, stderr: out.stderr, reports: spec.reports || [], repoRoot: ctx.root,
          readReport: (n) => { try { return readFileSync(join(ctx.outDir, n), "utf8"); } catch { return null; } },
        });
        if (out.status === 126) res.findings.push({ id: "tool-blocked", severity: "high", message: "command could not be executed (blocked or not executable)", location: "" });
      }
    }
  } catch (e) {
    if (e instanceof ToolMissing) res.findings = [{ id: "tool-missing", severity: "high", message: `${e.tool}: ${e.message}. Install: ${installHints(e.tool)}`, location: "" }];
    else res.findings = [{ id: "check-crashed", severity: "high", message: String(e.stack || e).split("\n").slice(0, 3).join(" | "), location: "" }];
  }
  const rel = (p) => String(p || "").split(ctx.scanRootPosix + "/").join("").split(ctx.scanRoot.replace(/\\/g, "/") + "/").join("");
  if (check.countPattern && res.findings.length && res.raw) {
    const text = res.text || "";
    let total = 0;
    for (const m of text.matchAll(new RegExp(check.countPattern, "g"))) total += Number(m[1]) || 0;
    if (total) res.estimated = total;
  }
  res.findings = res.findings.map((f) => ({ ...f, check: check.id, location: rel(f.location) }));
  const t1 = Date.now();
  res.endedAt = new Date(t1).toISOString();
  res.ms = t1 - t0;
  return res;
}

/**
 * @param {object[]} selected checks, in config order
 * @param {{log?:(r:object)=>void}} [o] called as each check finishes (completion order)
 * @returns {Promise<{results:object[], timing:{startedAt:string, endedAt:string, wallMs:number, concurrency:number, checkMsSum:number}}>}
 */
export async function runChecks(selected, pd, ctx, { log = () => {} } = {}) {
  const t0 = Date.now();
  const results = await pool(selected, pd.concurrency, async (c) => {
    // trivy-image locks per scan itself; any other trivy user holds the lock for its whole run (wait = queuedMs).
    const trivyUser = c.preset !== "trivy-image" && checkNeeds(c).tools.includes("trivy");
    const go = () => { r0 = Date.now() - t0; return runCheck(c, pd, ctx); };
    let r0 = 0;
    const r = trivyUser ? await TRIVY_LOCK.run(go) : await go();
    const queuedMs = r0;
    r.queuedMs = queuedMs;
    log(r);
    return r;
  });
  const t1 = Date.now();
  return {
    results,
    timing: { startedAt: new Date(t0).toISOString(), endedAt: new Date(t1).toISOString(), wallMs: t1 - t0, concurrency: pd.concurrency, checkMsSum: results.reduce((s, r) => s + r.ms, 0) },
  };
}
