// Third-party image debt (D063): unit tests of the pure core + end-to-end through the real gate runner
// (a throwaway git repo; the trivy-image preset is replaced by a fake so no Docker/network is needed).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRESETS } from "./catalog.mjs";
import { validatePredeploy } from "./config.mjs";
import { buildBaseline, evaluateImageDebt, findingKey, isoDay } from "./imagedebt.mjs";
import { main as runGate } from "./run.mjs";
import { reportPath, stampPath, verifyStamp } from "./state.mjs";
import { headSha } from "./lib.mjs";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };
const DAY = 86400000;
const TODAY = new Date("2026-10-02T12:00:00Z");
const plus = (days) => isoDay(TODAY.getTime() + days * DAY);

// ── pure core ───────────────────────────────────────────────────────────────
const fnd = (image, id, pkg = "libc@1", target = "debian 12") => ({ check: "trivy-images", id, severity: "high", message: "m", location: `${image}: ${target}`, resource: pkg, image, imageFinding: true });
const pins = [{ name: "mysql", pin: "mysql:8@sha256:aa", check: "trivy-images" }, { name: "redis", pin: "redis:7@sha256:bb", check: "trivy-images" }, { name: "call-plane", pin: "context:services/call-plane", check: "trivy-images" }];
const ent = (name, ref, keys, extra = {}) => ({ name, ref, owner: "Maayan", plan: "bump the base image", due: plus(9), baselined: plus(0), findings: keys, ...extra });
const file = (entries, problems = []) => ({ path: "predeploy-image-debt.json", entries, raw: "x", present: true, problems });
const base = { pins, ownImages: ["call-plane"], ranImages: new Set(["mysql", "redis", "call-plane"]), today: TODAY, maxDays: 30 };
const ids = (r) => r.blocking.map((f) => f.id).sort();
const K = (image, id) => findingKey(fnd(image, id));
const good = () => file([ent("mysql", "mysql:8@sha256:aa", [K("mysql", "CVE-1"), K("mysql", "CVE-2")]), ent("redis", "redis:7@sha256:bb", [])]);

await t("findings in the snapshot are debt (separate, counted, not blocking)", () => {
  const r = evaluateImageDebt([fnd("mysql", "CVE-1"), fnd("mysql", "CVE-2")], good(), base);
  assert.deepEqual(ids(r), []); assert.equal(r.total, 2); assert.equal(r.debt.length, 2); assert.equal(r.remaining.length, 0);
  assert.match(r.lines[0], /THIRD-PARTY IMAGE DEBT: 2 findings across 1 image, due 2026-10-11 .*NOT ZERO/);
});
await t("growth fails: a finding not in the snapshot stays blocking and is called out", () => {
  const r = evaluateImageDebt([fnd("mysql", "CVE-1"), fnd("mysql", "CVE-NEW")], good(), base);
  assert.deepEqual(ids(r), ["image-debt-growth"]); assert.equal(r.remaining.length, 1); assert.equal(r.remaining[0].id, "CVE-NEW");
});
await t("the image tarball path (different every run) is not part of a finding's identity", () => {
  const a = fnd("mysql", "CVE-1", "libc@1", ["C:", "runs", "aaa", "out", "image-mysql.tar (debian 12)"].join(String.fromCharCode(92)));
  const b = fnd("mysql", "CVE-1", "libc@1", "/c/other/run/out/image-mysql.tar (debian 12)");
  assert.equal(findingKey(a), findingKey(b)); assert.equal(findingKey(a), "CVE-1|libc@1|<image> (debian 12)");
  assert.notEqual(findingKey(a), findingKey(fnd("mysql", "CVE-1", "libc@1", "usr/lib/x/package.json")));
});
await t("a finding in a different target/package is new (key is rule+package+target)", () => {
  const r = evaluateImageDebt([fnd("mysql", "CVE-1", "libc@2")], good(), base);
  assert.deepEqual(ids(r), ["image-debt-growth"]);
});
await t("shrink passes and is reported as progress", () => {
  const r = evaluateImageDebt([fnd("mysql", "CVE-1")], good(), base);
  assert.deepEqual(ids(r), []); assert.equal(r.images.find((i) => i.name === "mysql").fixed, 1);
  assert.ok(r.lines.some((l) => /progress: 1 baseline finding/.test(l)));
});
await t("the due date: on the day passes, the day after fails with findings remaining, clean image never fails", () => {
  const fs = [fnd("mysql", "CVE-1")];
  assert.deepEqual(ids(evaluateImageDebt(fs, good(), { ...base, today: new Date(plus(9) + "T20:00:00Z") })), []);
  const late = evaluateImageDebt(fs, good(), { ...base, today: new Date(plus(10) + "T01:00:00Z") });
  assert.deepEqual(ids(late), ["image-debt-overdue"]); assert.equal(late.total, 1);
  assert.deepEqual(ids(evaluateImageDebt([], good(), { ...base, today: new Date(plus(40) + "T00:00:00Z") })).filter((i) => i === "image-debt-overdue"), []);
});
await t("our own image can never be listed, and its findings stay blocking", () => {
  const f = file([...good().entries, ent("call-plane", "context:services/call-plane", [K("call-plane", "CVE-9")])]);
  const r = evaluateImageDebt([fnd("call-plane", "CVE-9")], f, base);
  assert.ok(ids(r).includes("image-debt-own-image")); assert.equal(r.remaining.length, 1); assert.equal(r.total, 0);
});
await t("coverage: a pinned third-party image missing from the file fails (even with zero findings)", () => {
  const r = evaluateImageDebt([], file([ent("mysql", "mysql:8@sha256:aa", [])]), base);
  assert.deepEqual(ids(r), ["image-debt-unlisted"]); assert.match(r.blocking[0].message, /redis/);
});
await t("a changed digest fails until re-baselined; its findings stay blocking", () => {
  const r = evaluateImageDebt([fnd("mysql", "CVE-1")], good(), { ...base, pins: [{ ...pins[0], pin: "mysql:8@sha256:NEW" }, pins[1], pins[2]] });
  assert.deepEqual(ids(r), ["image-debt-ref-changed"]); assert.equal(r.remaining.length, 1);
});
await t("an entry for an image that is no longer pinned is stale", () => {
  assert.ok(ids(evaluateImageDebt([], file([...good().entries, ent("gone", "gone:1", [])]), base)).includes("image-debt-stale"));
});
await t("invalid entries: missing owner/plan, due beyond maxDays, due before baselined, junk keys, bad snapshot", () => {
  const r = evaluateImageDebt([], file([ent("mysql", "mysql:8@sha256:aa", [], { owner: "", plan: "x", due: plus(60), extra: 1, findings: ["nopipe"] }), ent("redis", "redis:7@sha256:bb", [], { due: plus(-1) })]), base);
  const msgs = r.blocking.map((f) => f.message).join("\n");
  for (const re of [/owner is required/, /plan is required/, /more than 30 days/, /unknown key "extra"/, /findings must be an array/, /due is before baselined/]) assert.match(msgs, re);
});
await t("a scan that did not complete neither counts nor shrinks the image", () => {
  const r = evaluateImageDebt([], good(), { ...base, ranImages: new Set(["redis"]) });
  assert.equal(r.images.find((i) => i.name === "mysql").fixed, null); assert.deepEqual(ids(r), []);
});

const flags = { owner: "Maayan", plan: "patch-layer rebuilds tracked in #T214", due: plus(9) };
await t("baseline: new entries need owner/plan/due; due is bounded; own images are skipped", () => {
  const find = [fnd("mysql", "CVE-1"), fnd("redis", "CVE-2"), fnd("call-plane", "CVE-3")];
  assert.match(buildBaseline(find, file([]), { ...base, flags: {} }).errors.join(), /new: pass --owner/);
  assert.match(buildBaseline(find, file([]), { ...base, flags: { ...flags, due: plus(45) } }).errors.join(), /more than 30 days/);
  assert.match(buildBaseline(find, file([]), { ...base, flags: { ...flags, due: plus(-1) } }).errors.join(), /in the past/);
  const r = buildBaseline(find, file([]), { ...base, flags });
  assert.deepEqual(r.file.entries.map((e) => e.name), ["mysql", "redis"]); assert.equal(r.file.entries[0].findings.length, 1);
  assert.equal(r.file.entries[0].ref, "mysql:8@sha256:aa");
});
await t("baseline never extends an existing due date, reports adds/removes, refuses an incomplete scan", () => {
  const old = file([ent("mysql", "mysql:8@sha256:aa", [K("mysql", "CVE-1"), K("mysql", "CVE-OLD")], { due: plus(3) }), ent("redis", "redis:7@sha256:bb", [])]);
  const r = buildBaseline([fnd("mysql", "CVE-1"), fnd("mysql", "CVE-NEW")], old, { ...base, flags });
  const my = r.file.entries.find((e) => e.name === "mysql");
  assert.equal(my.due, plus(3)); assert.deepEqual(r.changes.find((c) => c.name === "mysql"), { name: "mysql", created: false, added: 1, removed: 1, total: 2 });
  assert.match(buildBaseline([], old, { ...base, ranImages: new Set(["mysql"]), flags }).errors.join(), /"redis": the scan did not complete/);
});
await t("config: imageDebt needs ownImages and a trivy-image check", () => {
  const cfg = (idb, checks = [{ id: "t", preset: "trivy-image", options: { images: [] } }]) => ({ predeploy: { checks, imageDebt: idb } });
  assert.ok(validatePredeploy(cfg({})).some((m) => /ownImages/.test(m)));
  assert.ok(validatePredeploy(cfg({ ownImages: [] }, [{ id: "x", command: "true" }])).some((m) => /needs a trivy-image check/.test(m)));
  assert.ok(validatePredeploy(cfg({ ownImages: ["a"], maxDays: 200 })).some((m) => /maxDays/.test(m)));
  assert.deepEqual(validatePredeploy(cfg({ ownImages: ["a"] })), []);
});

// ── end to end through the real runner ──────────────────────────────────────
const repo = mkdtempSync(join(tmpdir(), "imagedebt-e2e-"));
const sh = (args) => { const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, args.join(" ") + r.stderr); return r.stdout.trim(); };
sh(["init", "-q"]); sh(["config", "user.email", "t@t"]); sh(["config", "user.name", "t"]); sh(["config", "commit.gpgsign", "false"]);
const images = (mysqlRef = "mysql:8@sha256:aa") => [{ name: "call-plane", context: "services/call-plane" }, { name: "mysql", ref: mysqlRef }, { name: "redis", ref: "redis:7@sha256:bb" }];
const cfgOf = (mysqlRef, extra = {}) => ({ project: { name: "t", slug: "t" }, predeploy: { checks: [{ id: "trivy-images", preset: "trivy-image", options: { images: images(mysqlRef) } }], imageDebt: { ownImages: ["call-plane"] }, ...extra } });
const commit = (cfg, files = {}) => {
  writeFileSync(join(repo, "maple.config.json"), JSON.stringify(cfg, null, 2));
  for (const [k, v] of Object.entries(files)) writeFileSync(join(repo, k), v);
  sh(["add", "-A"]); sh(["commit", "-q", "-m", "c", "--allow-empty"]);
};
let scan = [];
PRESETS["trivy-image"].run = async () => ({ findings: scan });
const run = async (args, opts) => {
  const lines = []; const log = console.log; console.log = (...a) => lines.push(a.join(" "));
  const err = console.error; console.error = (...a) => lines.push(a.join(" "));
  try { return { code: await runGate(["--root", repo, ...args], opts), text: lines.join("\n") }; } finally { console.log = log; console.error = err; }
};
const report = () => JSON.parse(readFileSync(reportPath(repo, headSha(repo)), "utf8"));
const blockIds = () => report().blocking.map((f) => `${f.check}:${f.id}`);
const REBASE = ["--rebaseline-image-debt", "--owner", flags.owner, "--plan", flags.plan, "--due", flags.due];
const SCAN3 = [fnd("mysql", "CVE-1"), fnd("mysql", "CVE-2"), fnd("redis", "CVE-3")];

await t("no file: every third-party image is unlisted and its findings block", async () => {
  scan = SCAN3; commit(cfgOf());
  const r = await run([], { today: TODAY });
  assert.equal(r.code, 1); const b = blockIds();
  assert.ok(b.includes("image-debt:image-debt-unlisted") && b.includes("trivy-images:CVE-1"), b.join());
});
await t("--rebaseline-image-debt without flags fails; with flags writes the file (never a stamp)", async () => {
  assert.equal((await run(["--rebaseline-image-debt"], { today: TODAY })).code, 2);
  const r = await run(REBASE, { today: TODAY });
  assert.equal(r.code, 0, r.text); assert.match(r.text, /\+ NEW mysql: 2 finding\(s\)/); assert.match(r.text, /ADDS 3 finding/);
  const f = JSON.parse(readFileSync(join(repo, "predeploy-image-debt.json"), "utf8"));
  assert.deepEqual(f.entries.map((e) => e.name), ["mysql", "redis"]); assert.equal(f.entries[0].due, flags.due);
});
await t("an uncommitted debt file fails the gate", async () => {
  const r = await run(["--allow-dirty"], { today: TODAY });
  assert.equal(r.code, 1); assert.ok(blockIds().includes("image-debt:image-debt-uncommitted"));
  sh(["add", "-A"]); sh(["commit", "-q", "-m", "debt"]);
});
await t("committed snapshot: gate passes with 0 blocking, debt reported separately, stamp binds the file hash", async () => {
  const r = await run([], { today: TODAY });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /THIRD-PARTY IMAGE DEBT: 3 findings across 2 images, due 2026-10-11 .*NOT ZERO/);
  const rep = report(); assert.equal(rep.totals.blocking, 0); assert.equal(rep.totals.imageDebt, 3);
  assert.equal(rep.imageDebt.images.length, 2); assert.equal(rep.checks[0].imageDebt, 3);
  const st = JSON.parse(readFileSync(stampPath(repo, headSha(repo)), "utf8"));
  assert.equal(typeof st.imageDebtHash, "string"); assert.equal(st.imageDebt, 3);
  assert.equal(verifyStamp(repo).ok, true);
  writeFileSync(stampPath(repo, headSha(repo)), JSON.stringify({ ...st, imageDebtHash: "0".repeat(64) }));
  assert.equal(verifyStamp(repo).ok, false); assert.match(verifyStamp(repo).reason, /image debt file changed/);
});
await t("shrink (a fix) passes and is reported as progress", async () => {
  scan = SCAN3.slice(1);
  const r = await run([], { today: TODAY });
  assert.equal(r.code, 0, r.text); assert.match(r.text, /progress: 1 baseline finding/); assert.match(r.text, /THIRD-PARTY IMAGE DEBT: 2 findings/);
});
await t("growth fails the gate; an explicit re-baseline accepts it as a reviewable diff", async () => {
  scan = [...SCAN3, fnd("redis", "CVE-NEW")];
  assert.equal((await run([], { today: TODAY })).code, 1);
  assert.ok(blockIds().includes("image-debt:image-debt-growth") && blockIds().includes("trivy-images:CVE-NEW"));
  const rb = await run(["--rebaseline-image-debt"], { today: TODAY });
  assert.equal(rb.code, 0, rb.text); assert.match(rb.text, /redis: 2 finding\(s\) \(\+1 added/);
  assert.match(sh(["diff", "--stat"]), /predeploy-image-debt\.json/);
  sh(["add", "-A"]); sh(["commit", "-q", "-m", "rebaseline"]);
  assert.equal((await run([], { today: TODAY })).code, 0);
  const f = JSON.parse(readFileSync(join(repo, "predeploy-image-debt.json"), "utf8"));
  assert.equal(f.entries[0].due, flags.due, "re-baselining never moves the due date");
});
await t("after the due date any remaining finding fails the gate; fixed images do not", async () => {
  const late = new Date(plus(10) + "T08:00:00Z");
  assert.equal((await run([], { today: late })).code, 1);
  assert.ok(blockIds().includes("image-debt:image-debt-overdue"));
  scan = [];
  assert.equal((await run([], { today: late })).code, 0);
  scan = [...SCAN3, fnd("redis", "CVE-NEW")];
});
await t("a changed digest fails until it is re-baselined", async () => {
  commit(cfgOf("mysql:8@sha256:cc"));
  assert.equal((await run([], { today: TODAY })).code, 1);
  assert.ok(blockIds().includes("image-debt:image-debt-ref-changed"));
  assert.equal((await run(["--rebaseline-image-debt"], { today: TODAY })).code, 0);
  assert.equal(JSON.parse(readFileSync(join(repo, "predeploy-image-debt.json"), "utf8")).entries[0].ref, "mysql:8@sha256:cc");
  sh(["add", "-A"]); sh(["commit", "-q", "-m", "rebaseline digest"]);
  assert.equal((await run([], { today: TODAY })).code, 0);
});
await t("our own image: findings block, and listing it as debt is rejected", async () => {
  scan = [...SCAN3, fnd("redis", "CVE-NEW"), fnd("call-plane", "CVE-OWN")];
  assert.equal((await run([], { today: TODAY })).code, 1); assert.ok(blockIds().includes("trivy-images:CVE-OWN"));
  const f = JSON.parse(readFileSync(join(repo, "predeploy-image-debt.json"), "utf8"));
  f.entries.push({ name: "call-plane", ref: "context:services/call-plane", owner: "x", plan: "list our own image", due: flags.due, baselined: isoDay(TODAY), findings: [findingKey(fnd("call-plane", "CVE-OWN"))] });
  commit(cfgOf("mysql:8@sha256:cc"), { "predeploy-image-debt.json": JSON.stringify(f) });
  assert.equal((await run([], { today: TODAY })).code, 1);
  assert.ok(blockIds().includes("image-debt:image-debt-own-image") && blockIds().includes("trivy-images:CVE-OWN"));
});
await t("--rebaseline-image-debt refuses when a scan did not complete", async () => {
  scan = [{ id: "image-scan-failed", severity: "high", message: "no report", location: "redis", image: "redis" }];
  const r = await run(["--rebaseline-image-debt"], { today: TODAY });
  assert.equal(r.code, 2); assert.match(r.text, /"redis": the scan did not complete/);
});

console.log(`\n${n} image-debt tests passed`);
rmSync(repo, { recursive: true, force: true });
