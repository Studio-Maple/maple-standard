/**
 * imagedebt.mjs — the dated, honest "third-party image debt" category of the
 * pre-deploy gate (D063). It is NOT an allowlist: it is a time-boxed, no-growth
 * ledger for third-party images we run but cannot patch ourselves yet.
 *
 * File (`predeploy.imageDebt.file`, default `predeploy-image-debt.json`, committed):
 *   { "version": 1, "entries": [
 *     { "name": "mysql",                       // the trivy-image `name`
 *       "ref":  "mysql:8.0@sha256:…",          // the exact pin (`context:<dir>` for an image we build from a third-party base)
 *       "owner": "Maayan", "plan": "how and when this gets fixed (>= 10 chars)",
 *       "due": "YYYY-MM-DD",                   // after this date any remaining finding fails the gate
 *       "baselined": "YYYY-MM-DD",             // written by --rebaseline-image-debt
 *       "findings": [ "CVE-…|pkg@ver|target" ] // SNAPSHOT of finding keys, written by --rebaseline-image-debt
 *     } ] }
 *
 * Findings of a listed image that are in its snapshot are reported in their own
 * prominent block ("THIRD-PARTY IMAGE DEBT: N findings across M images, due D"),
 * never counted as zero and never mixed into the blocking count. The gate FAILS on:
 *   image-debt-growth        a finding NOT in the snapshot (new CVE, or the image changed)
 *   image-debt-ref-changed   the pinned ref differs from the entry's (digest bump => re-baseline)
 *   image-debt-overdue       due date passed with findings remaining
 *   image-debt-unlisted      a non-own pinned image has no entry (coverage)
 *   image-debt-own-image     one of OUR images (ownImages) is listed — ours must be zero
 *   image-debt-stale         an entry for an image that is no longer pinned
 *   image-debt-invalid       bad shape, bad dates, due further than maxDays after `baselined`
 *   image-debt-uncommitted   the file is untracked or modified vs HEAD
 * Shrink (fixes) is allowed and reported as progress. Adding findings to a
 * snapshot requires an explicit `run.mjs --rebaseline-image-debt` whose output
 * file is committed (a reviewable diff). A rebaseline never extends `due`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { git, sha256 } from "./lib.mjs";

export const IMAGE_DEBT_DEFAULT_PATH = "predeploy-image-debt.json";
export const IMAGE_DEBT_MAX_DAYS_DEFAULT = 30;
export const IMAGE_DEBT_RULE = "THIRD-PARTY IMAGE DEBT is dated and shrink-only: no new findings, no passing the due date, never our own images";

const DAY = 86400000;
const ENTRY_KEYS = ["name", "ref", "owner", "plan", "due", "baselined", "findings"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const dayMs = (s) => (ISO.test(String(s)) && !Number.isNaN(new Date(s + "T00:00:00Z").getTime()) ? new Date(s + "T00:00:00Z").getTime() : null);
export const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

export function loadImageDebt(root, relPath) {
  const abs = join(root, relPath);
  if (!existsSync(abs)) return { path: relPath, entries: [], raw: "", present: false, problems: [] };
  const raw = readFileSync(abs, "utf8");
  const problems = [];
  let entries = [];
  try {
    const j = JSON.parse(raw);
    if (!j || j.version !== 1 || !Array.isArray(j.entries)) problems.push("must be { version: 1, entries: [...] }");
    else entries = j.entries;
  } catch (e) {
    problems.push("not valid JSON: " + e.message);
  }
  return { path: relPath, entries, raw, present: true, problems };
}

export const imageDebtHash = (d) => sha256(d.raw || "");

export function imageDebtCommitted(root, d) {
  if (!d.present) return true;
  if (git(root, ["ls-files", "--error-unmatch", d.path]) === null) return false;
  return git(root, ["status", "--porcelain", "--", d.path]) === "";
}

/** Every image the trivy-image checks scan: { name, pin, check }. `pin` is the exact ref, or context:<dir> for a tree build. */
export function trivyPins(pd) {
  const out = [];
  for (const c of pd.checks || []) {
    if (c.preset !== "trivy-image") continue;
    for (const im of c.options?.images || []) out.push({ name: im.name, pin: im.ref || `context:${im.context}`, check: c.id });
  }
  return out;
}

/** Stable identity of one finding inside an image: rule + package + scan target (image prefix and line numbers stripped). */
export function findingKey(f) {
  const target = String(f.location || "").replace(new RegExp(`^${String(f.image).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `), "");
  return `${f.id}|${f.resource || ""}|${target}`;
}

const IMAGE_INFRA = /^(image-(pull|build|save|scan)-failed|secret-missing|misconfigured|tool-missing|tool-blocked|check-crashed|spawn-failed|timeout|no-report|unparseable-report)$/;

/** Images whose scan completed in this invocation (their absence of a finding is real). */
export function scannedImages(results, pins) {
  const ran = new Set();
  for (const r of results) {
    const mine = pins.filter((p) => p.check === r.id);
    for (const p of mine) if (!r.findings.some((f) => IMAGE_INFRA.test(f.id) && (!f.image || f.image === p.name))) ran.add(p.name);
  }
  return ran;
}

const F = (id, message, location, severity = "high") => ({ check: "image-debt", id, severity, message, location });

/** Structural validation of one entry; returns the list of problems (empty = well-formed). */
function entryProblems(e, today, maxDays) {
  const p = [];
  if (!e || typeof e !== "object" || Array.isArray(e)) return ["not an object"];
  for (const k of Object.keys(e)) if (!ENTRY_KEYS.includes(k)) p.push(`unknown key "${k}"`);
  if (!isStr(e.name)) p.push("name is required");
  if (!isStr(e.ref)) p.push("ref is required (the exact pin, or context:<dir>)");
  if (!isStr(e.owner)) p.push("owner is required");
  if (!isStr(e.plan) || e.plan.trim().length < 10) p.push("plan is required (>= 10 chars: how and when this gets fixed)");
  const due = dayMs(e.due), base = dayMs(e.baselined);
  if (due === null) p.push("due must be a real YYYY-MM-DD date");
  if (base === null) p.push("baselined must be a real YYYY-MM-DD date (written by --rebaseline-image-debt)");
  else if (base > today.getTime() + DAY) p.push("baselined is in the future");
  if (due !== null && base !== null) {
    if (due < base) p.push("due is before baselined");
    else if (due > base + maxDays * DAY) p.push(`due ${e.due} is more than ${maxDays} days after baselined ${e.baselined} — debt must be short-lived (predeploy.imageDebt.maxDays)`);
  }
  if (!Array.isArray(e.findings) || !e.findings.every((x) => typeof x === "string" && x.includes("|"))) p.push('findings must be an array of "id|resource|target" keys');
  else if (new Set(e.findings).size !== e.findings.length) p.push("findings has duplicate keys");
  return p;
}

/**
 * Splits the findings into: remaining (still ordinary findings, incl. growth) and debt (in-snapshot findings of
 * listed images), and produces the gate's structural findings + the report block.
 * @param findings all post-floor findings; image findings carry { image, imageFinding:true }
 * @param opts { pins, ownImages, ranImages:Set, today:Date, maxDays }
 */
export function evaluateImageDebt(findings, d, { pins, ownImages = [], ranImages = new Set(), today = new Date(), maxDays = IMAGE_DEBT_MAX_DAYS_DEFAULT }) {
  const block = d.problems.map((m) => F("image-debt-invalid", m, d.path));
  const own = new Set(ownImages);
  const pinByName = new Map(pins.map((p) => [p.name, p]));
  const usable = new Map();
  const listed = new Set();
  d.entries.forEach((e, i) => {
    const bad = (id, m) => block.push(F(id, `entry ${i}${e?.name ? ` (${e.name})` : ""}: ${m}`, d.path));
    const probs = entryProblems(e, today, maxDays);
    if (e && typeof e === "object" && isStr(e.name)) listed.add(e.name);
    for (const m of probs) bad("image-debt-invalid", m);
    if (probs.length || !isStr(e.name)) return;
    if (own.has(e.name)) return bad("image-debt-own-image", `"${e.name}" is one of our own images — our images must have zero findings and can never be listed as debt`);
    const pin = pinByName.get(e.name);
    if (!pin) return bad("image-debt-stale", `"${e.name}" is not a pinned trivy-image image any more — remove the entry`);
    if (usable.has(e.name)) return bad("image-debt-invalid", `duplicate entry for "${e.name}"`);
    if (pin.pin !== e.ref) return bad("image-debt-ref-changed", `pinned ref is now ${pin.pin} but the entry baselines ${e.ref} — the image changed; review it and re-baseline explicitly (run.mjs --rebaseline-image-debt) so the diff is committed`);
    usable.set(e.name, e);
  });
  for (const p of pins) if (!own.has(p.name) && !listed.has(p.name)) block.push(F("image-debt-unlisted", `third-party image "${p.name}" (${p.pin}) is pinned but not in ${d.path} — list it (owner, plan, due) via --rebaseline-image-debt, even with zero findings; if it is ours add it to predeploy.imageDebt.ownImages`, d.path));

  const snap = new Map([...usable].map(([n, e]) => [n, new Set(e.findings)]));
  const seen = new Map([...usable.keys()].map((n) => [n, new Set()]));
  const growth = new Map();
  const remaining = [];
  const debt = [];
  for (const f of findings) {
    const e = f.imageFinding ? usable.get(f.image) : null;
    if (!e) { remaining.push(f); continue; }
    const key = findingKey(f);
    if (snap.get(e.name).has(key)) { seen.get(e.name).add(key); debt.push({ ...f, imageDebt: { owner: e.owner, due: e.due } }); }
    else { remaining.push(f); growth.set(e.name, [...(growth.get(e.name) || []), f]); }
  }
  for (const [name, fs] of growth) block.push(F("image-debt-growth", `${fs.length} finding(s) in "${name}" are NOT in the baseline snapshot (e.g. ${fs.slice(0, 3).map((f) => `${f.id} ${f.resource || ""}`.trim()).join(", ")}) — no growth allowed: fix them, or re-baseline explicitly (run.mjs --rebaseline-image-debt) and commit the reviewable diff`, name));

  const todayIso = isoDay(today);
  const images = [];
  for (const e of usable.values()) {
    const ran = ranImages.has(e.name);
    const count = seen.get(e.name).size;
    const row = {
      name: e.name, ref: e.ref, owner: e.owner, plan: e.plan, due: e.due, baselined: e.baselined,
      baseline: e.findings.length, ran, count: ran ? count : null,
      fixed: ran ? e.findings.length - count : null, newFindings: (growth.get(e.name) || []).length,
      daysLeft: Math.floor((dayMs(e.due) - dayMs(todayIso)) / DAY), overdue: false,
    };
    if (ran && count > 0 && todayIso > e.due) {
      row.overdue = true;
      block.push(F("image-debt-overdue", `"${e.name}": ${count} finding(s) remain and the due date ${e.due} has passed (${-row.daysLeft} day(s) ago; owner ${e.owner}) — fix the image; the date is not extendable by re-baselining`, e.name));
    }
    images.push(row);
  }
  images.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.name.localeCompare(b.name));
  const scanned = images.filter((r) => r.ran);
  const total = scanned.reduce((s, r) => s + r.count, 0);
  const withDebt = scanned.filter((r) => r.count > 0);
  const dues = [...new Set(withDebt.map((r) => r.due))].sort();
  const lines = [];
  if (scanned.length) {
    const dueTxt = !dues.length ? "none outstanding" : dues.length === 1 ? `due ${dues[0]}` : `earliest due ${dues[0]} (latest ${dues[dues.length - 1]})`;
    lines.push(`*** THIRD-PARTY IMAGE DEBT: ${total} finding${total === 1 ? "" : "s"} across ${withDebt.length} image${withDebt.length === 1 ? "" : "s"}, ${dueTxt} — NOT ZERO; fails the gate after the due date and on any growth ***`);
    lines.push(`    rule: ${IMAGE_DEBT_RULE}`);
    for (const r of scanned) lines.push(`    image-debt: ${r.name} — ${r.count} finding${r.count === 1 ? "" : "s"} (baseline ${r.baseline}${r.fixed ? `, ${r.fixed} fixed since` : ""}${r.newFindings ? `, ${r.newFindings} NEW` : ""}), owner ${r.owner}, due ${r.due} (${r.overdue ? "OVERDUE" : r.daysLeft + "d left"}) — ${r.plan}`);
    const fixedTotal = scanned.reduce((s, r) => s + r.fixed, 0);
    if (fixedTotal) lines.push(`    progress: ${fixedTotal} baseline finding(s) fixed since the snapshot — shrink is allowed; --rebaseline-image-debt records it`);
  } else if (d.entries.length) lines.push(`(image debt: ${d.entries.length} entries in ${d.path}; no listed image was scanned this run)`);
  return { remaining, debt, blocking: block, images, total, imagesWithDebt: withDebt.length, dueEarliest: dues[0] || null, rule: IMAGE_DEBT_RULE, lines };
}

/**
 * Builds the file for `--rebaseline-image-debt`: a fresh snapshot of every non-own pinned image, preserving each
 * existing entry's owner/plan/due (never extends a date). New entries need flags { owner, plan, due }.
 * @returns {{ errors:string[], file?:object, text?:string, changes:object[] }}
 */
export function buildBaseline(findings, d, { pins, ownImages = [], ranImages, today = new Date(), maxDays = IMAGE_DEBT_MAX_DAYS_DEFAULT, flags = {} }) {
  const errors = [];
  const own = new Set(ownImages);
  const old = new Map(d.entries.filter((e) => e && isStr(e.name)).map((e) => [e.name, e]));
  const todayIso = isoDay(today);
  const entries = [];
  const changes = [];
  for (const p of pins) {
    if (own.has(p.name)) continue;
    if (!ranImages.has(p.name)) { errors.push(`"${p.name}": the scan did not complete — cannot snapshot (fix the scan failure first)`); continue; }
    const keys = [...new Set(findings.filter((f) => f.imageFinding && f.image === p.name).map(findingKey))].sort();
    const prev = old.get(p.name);
    const keep = prev && isStr(prev.owner) && isStr(prev.plan) && dayMs(prev.due) !== null;
    const owner = keep ? prev.owner : flags.owner, plan = keep ? prev.plan : flags.plan, due = keep ? prev.due : flags.due;
    if (!keep) {
      if (!isStr(owner) || !isStr(plan) || !isStr(due)) { errors.push(`"${p.name}" is new: pass --owner, --plan and --due YYYY-MM-DD`); continue; }
      const dm = dayMs(due);
      if (dm === null) { errors.push(`--due "${due}" is not a real YYYY-MM-DD date`); continue; }
      if (due < todayIso) { errors.push(`--due ${due} is in the past`); continue; }
      if (dm > dayMs(todayIso) + maxDays * DAY) { errors.push(`--due ${due} is more than ${maxDays} days away (predeploy.imageDebt.maxDays)`); continue; }
    }
    const before = new Set(prev?.findings || []);
    changes.push({ name: p.name, created: !prev, added: keys.filter((k) => !before.has(k)).length, removed: [...before].filter((k) => !keys.includes(k)).length, total: keys.length });
    entries.push({ name: p.name, ref: p.pin, owner, plan, due, baselined: todayIso, findings: keys });
  }
  const dropped = [...old.keys()].filter((n) => !entries.some((e) => e.name === n));
  for (const n of dropped) changes.push({ name: n, dropped: true });
  if (errors.length) return { errors, changes };
  const file = { version: 1, note: "Third-party image debt (maple-standard predeploy, D063). Regenerate ONLY with run.mjs --rebaseline-image-debt and commit the diff; never edit snapshots by hand.", entries };
  return { errors, file, text: JSON.stringify(file, null, 2) + "\n", changes };
}
