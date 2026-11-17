#!/usr/bin/env node
/**
 * gate-cli.mjs - the command line over gate-state.mjs (D066). Called by scripts/ci-local.sh and by hand.
 *
 *   skip   --step S [--ref #T15] [--sha SHA]    MAPLE_GATE_SKIP=<reason> -> validate the reason and the
 *                                               step, VERIFY the reason is true on this machine, append
 *                                               debt. Exit 0 = the step may be skipped; 2 = unlisted reason;
 *                                               3 = valid reason that does not cover this step (run it);
 *                                               1 = the reason is false on this machine (run the step).
 *   validate                                    exit 2 when MAPLE_GATE_SKIP is set to an unlisted reason (ci-local runs it first)
 *   record --sha SHA --step S --reason R [--ref ..] [--branch B]
 *                                               append a debt entry without verification (history/seeding:
 *                                               recording debt can only add blockers)
 *   list   [--head SHA] [--all]                 unpaid debt (default) as JSON lines
 *   pay    --heavy-sha SHA                      mark every unpaid debt contained in SHA as paid
 *   stamp  [--sha SHA] [--skipped N]            heavy green: write heavy-pass/<sha>.json and pay debt.
 *                                               Refuses on a dirty tracked tree, a sha that is not HEAD,
 *                                               or --skipped > 0 (a run with skips never pays or stamps)
 *   attest [--kind heavy|predeploy] --sha SHA --officeci-job J
 *                                               import a tier pass verified on OfficeCI (D073): job passed, same origin repo,
 *                                               success line + `officeci-sha SHA` in the log; writes who=officeci:J via=attest.
 *                                               Any failed check exits 1 and writes nothing. Never --live (see attest.mjs)
 *   carry  [--check]                            opt-in heavy carry-over (gate.heavyCarryOver, heavy-carry.mjs): HEAD differs from
 *                                               the nearest first-parent ancestor with a REAL green heavy run only in in-place
 *                                               edits of listed data files / listed maple.config.json keys -> write
 *                                               heavy-pass/<HEAD>.json {via:"carry", carriedFrom, paths, configKeys, at: the
 *                                               ORIGIN's time, carriedAt}. Never pays debt. Refuses on a dirty tracked tree,
 *                                               unpaid debt, a real record already on HEAD, or any eligibility failure (exit 1).
 *                                               --check prints the verdict and writes nothing. Readers re-verify the record.
 *   verify [--sha SHA]                      promotion requirement: heavy stamp for sha + no unpaid debt
 *   base   [--head SHA]                         last heavy-stamped ancestor of head (empty when none)
 *
 * Reason via --reason or $MAPLE_GATE_SKIP; deprecated $SKIP_LIVE_GATE=1 maps to docker-unavailable
 * (honoured only when docker really is unavailable - the same verification as any skip).
 */
import { pathToFileURL } from "node:url";
import { git, isRealHeavyPass, lastHeavyBase, nowIso, payDebt, readHeavyStamp, recordDebt, resolveSha, unpaidDebt, validateSkip, verifyPromotion, verifyReason, who, writeHeavyStamp } from "./gate-state.mjs";
import { carryEligibility } from "./heavy-carry.mjs";

function parse(argv) {
  const a = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v.startsWith("--")) {
      const k = v.slice(2);
      const nxt = argv[i + 1];
      if (nxt === undefined || nxt.startsWith("--")) a.flags[k] = true;
      else { a.flags[k] = nxt; i++; }
    } else a._.push(v);
  }
  return a;
}

/** reason from flag/env, with the deprecated alias */
export function reasonFromEnv(flags, env = process.env) {
  if (typeof flags.reason === "string") return flags.reason;
  if (env.MAPLE_GATE_SKIP) return env.MAPLE_GATE_SKIP;
  if (env.SKIP_LIVE_GATE === "1") return "docker-unavailable";
  return "";
}

export async function main(argv, { root = process.cwd(), env = process.env, out = console.log, err = console.error, deps } = {}) {
  const { _: [cmd], flags } = parse(argv);
  const R = typeof flags.root === "string" ? flags.root : root;
  const head = () => git(R, ["rev-parse", "HEAD"]);
  switch (cmd) {
    case "skip": {
      const step = flags.step;
      const reason = reasonFromEnv(flags, env);
      const v = validateSkip({ reason });
      if (!v.ok) { err("MAPLE_GATE_SKIP refused: " + v.error); return 2; }
      if (!validateSkip({ reason, step }).ok) return 3; // a valid reason that does not cover this step: the step simply runs
      const ver = await verifyReason(R, reason, deps);
      if (!ver.ok) { err(`MAPLE_GATE_SKIP=${reason} refused for step '${step}': ${ver.detail}`); return 1; }
      const e = recordDebt(R, { sha: flags.sha || head(), step, reason, ref: typeof flags.ref === "string" ? flags.ref : undefined });
      out(`gate debt recorded: step '${step}' skipped (${reason}: ${ver.detail}) at ${e.sha.slice(0, 10)} - paid by the next green heavy run`);
      return 0;
    }
    case "validate": {
      const reason = reasonFromEnv(flags, env);
      if (!reason) return 0;
      const v = validateSkip({ reason });
      if (!v.ok) err("MAPLE_GATE_SKIP refused: " + v.error);
      return v.ok ? 0 : 2;
    }
    case "record": {
      if (!flags.step || !flags.reason) { err("record needs --step and --reason"); return 2; }
      const sha = resolveSha(R, typeof flags.sha === "string" ? flags.sha : "HEAD");
      if (!sha) { err("unknown --sha"); return 2; }
      const e = recordDebt(R, { sha, step: flags.step, reason: flags.reason, ref: typeof flags.ref === "string" ? flags.ref : undefined, branch: typeof flags.branch === "string" ? flags.branch : undefined });
      out(JSON.stringify(e));
      return 0;
    }
    case "list": {
      const list = unpaidDebt(R, { head: typeof flags.head === "string" ? flags.head : undefined });
      for (const d of list) out(JSON.stringify(d));
      if (!list.length && !flags.quiet) err("no unpaid gate debt");
      return 0;
    }
    case "pay": {
      const sha = resolveSha(R, flags["heavy-sha"] || "HEAD");
      if (!sha) { err("unknown --heavy-sha"); return 2; }
      const settled = payDebt(R, sha);
      out(`paid ${settled.length} gate debt entr${settled.length === 1 ? "y" : "ies"}`);
      return 0;
    }
    case "stamp": {
      const sha = resolveSha(R, flags.sha || "HEAD");
      if (!sha) { err("unknown --sha"); return 2; }
      if (Number(flags.skipped || 0) > 0) { err(`heavy run skipped ${flags.skipped} step(s): no stamp, no debt paid`); return 1; }
      if (sha !== head()) { err("stamp refused: --sha is not HEAD of this checkout"); return 1; }
      const dirty = git(R, ["status", "--porcelain", "--untracked-files=no"]);
      if (dirty === null || dirty.length) { err("stamp refused: tracked files differ from HEAD"); return 1; }
      const rec = writeHeavyStamp(R, sha);
      const settled = payDebt(R, sha);
      out(`heavy pass stamp written for ${sha.slice(0, 10)}${settled.length ? `; paid ${settled.length} gate debt entr${settled.length === 1 ? "y" : "ies"}` : ""}`);
      return rec ? 0 : 1;
    }
    case "attest": {
      try {
        const { attest } = await import("./attest.mjs");
        out(await attest({ kind: flags.kind === undefined ? "heavy" : flags.kind, sha: flags.sha, job: flags["officeci-job"], root: R, env, fetchImpl: deps?.fetchImpl, store: deps?.store, urlStore: deps?.urlStore }));
        return 0;
      } catch (e) {
        err("attest refused, nothing written: " + (e?.message ?? e));
        return 1;
      }
    }
    case "carry": {
      for (const k of Object.keys(flags)) if (!["check", "root"].includes(k)) { err(`carry refused: unknown flag --${k} (carry always targets HEAD and computes its origin itself)`); return 2; }
      const sha = head();
      if (!sha) { err("carry refused: no HEAD"); return 2; }
      const dirty = git(R, ["status", "--porcelain", "--untracked-files=no"]);
      if (dirty === null || dirty.length) { err("carry refused: tracked files differ from HEAD"); return 1; }
      if (isRealHeavyPass(readHeavyStamp(R, sha), sha)) { err(`carry refused: ${sha.slice(0, 10)} already has a real green heavy run`); return 1; }
      const debt = unpaidDebt(R, { head: sha });
      if (debt.length) { err(`carry refused: ${debt.length} unpaid gate debt entr${debt.length === 1 ? "y" : "ies"} in HEAD's history - only a green full heavy run pays it`); return 1; }
      const c = carryEligibility(R, sha, { readStamp: readHeavyStamp });
      if (!c.ok) { err(`carry refused (${c.code}): ${c.reason}`); return 1; }
      const what = [...c.paths, ...c.configKeys.map((k) => "maple.config.json:" + k)].join(", ") || "nothing";
      if (flags.check) { out(`carry eligible: ${sha.slice(0, 10)} from ${c.from.slice(0, 10)} (green heavy run at ${c.originAt}); changed: ${what}`); return 0; }
      writeHeavyStamp(R, sha, { at: c.originAt, who: who(), via: "carry", carriedFrom: c.from, carriedFromTree: c.fromTree, carriedAt: nowIso(), paths: c.paths, configKeys: c.configKeys, origin: { who: c.originWho ?? null, via: c.originVia ?? null } });
      out(`heavy pass carried to ${sha.slice(0, 10)} from ${c.from.slice(0, 10)} (green heavy run at ${c.originAt}); changed: ${what}. No gate debt paid. The predeploy gate must still run on this commit.`);
      return 0;
    }
    case "verify": {
      const sha = resolveSha(R, flags.sha || "HEAD");
      if (!sha) { err("unknown --sha"); return 2; }
      const r = verifyPromotion(R, sha);
      (r.ok ? out : err)((r.ok ? "OK: " : "REFUSED: ") + r.reason);
      return r.ok ? 0 : 1;
    }
    case "base": {
      const b = lastHeavyBase(R, resolveSha(R, flags.head || "HEAD") || "HEAD");
      if (b) out(b);
      return 0;
    }
    case "has-stamp": {
      const sha = resolveSha(R, flags.sha || "HEAD");
      return sha && isRealHeavyPass(readHeavyStamp(R, sha), sha) ? 0 : 1; // a carry is not a heavy RUN
    }
    default:
      err("usage: gate-cli.mjs skip|record|list|pay|stamp|attest|carry|verify|base|has-stamp (see the file header)");
      return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
