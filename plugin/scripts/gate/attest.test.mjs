// D073 gate-cli attest: pass cases and every failure case against a fake OfficeCI coordinator (a local HTTP stub that
// speaks the real shapes: GET /api/jobs/<id> JSON, GET /api/jobs/<id>/stream SSE). Hermetic: throwaway git repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./gate-cli.mjs";
import { HEAVY_MARKER, URL_CRED_TARGETS, coordinatorUrl, credentialFromStore, normalizeRepoUrl, parseSseLog } from "./attest.mjs";
import { heavyStampPath, mapleDir, readDebt, readHeavyStamp, recordDebt } from "./gate-state.mjs";

const ORIGIN = "https://github.com/acme/widgets.git";
const TOKEN = "tok-secret-do-not-print";
const repo = mkdtempSync(join(tmpdir(), "attest-"));
const g = (...args) => { const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, args.join(" ") + r.stderr); return r.stdout.trim(); };
g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t"); g("config", "commit.gpgsign", "false");
g("remote", "add", "origin", ORIGIN);
writeFileSync(join(repo, "a"), "a"); g("add", "-A"); g("commit", "-q", "-m", "a");
const A = g("rev-parse", "HEAD");
writeFileSync(join(repo, "maple.config.json"), JSON.stringify({ predeploy: { stampTtlHours: 72 } }));
writeFileSync(join(repo, "b"), "b"); g("add", "-A"); g("commit", "-q", "-m", "b");
const B = g("rev-parse", "HEAD"); // HEAD
const TREE_B = g("rev-parse", `${B}^{tree}`);

// ── the fake coordinator ────────────────────────────────────────────────────
const jobs = new Map(); // id -> { job, log, end }
const seen = [];
const sseOf = (log, end = true, split = 7) => {
  let s = "";
  for (let i = 0, seq = 1; i < log.length; i += split, seq++) s += `event: log\ndata: ${JSON.stringify({ seq, at: 1, text: log.slice(i, i + split) })}\n\n`;
  s += `event: state\ndata: {}\n\n`;
  return end ? s + `event: end\ndata: {"state":"passed"}\n\n` : s;
};
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
  const m = /^\/api\/jobs\/([^/]+)(\/stream)?$/.exec(req.url);
  const j = m && jobs.get(decodeURIComponent(m[1]));
  if (!j) { res.writeHead(404).end(); return; }
  if (m[2]) { res.writeHead(200, { "content-type": "text/event-stream" }).end(sseOf(j.log, j.end !== false)); return; }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(j.job));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL_ = `http://127.0.0.1:${server.address().port}`;

const FINISHED = Date.parse("2026-11-10T12:00:00Z");
const heavyLog = (sha) => `starting\nofficeci-sha ${sha}\nstep 1 ok\n${HEAVY_MARKER}\n`;
const predeployLog = (sha, extra = "") => `officeci-sha ${sha}\npredeploy gate - 3 check(s) on ${sha.slice(0, 8)}\n ok  gitleaks   blocking=0 allowlisted=0\n ok  trivy-fs   blocking=0 allowlisted=1\n${extra}\nSTAMP ISSUED for ${sha.slice(0, 8)} (valid 72h, bound to config + allowlist)\n`;
const mk = (id, { job = {}, log, end } = {}) => jobs.set(id, { job: { id, repo: ORIGIN, state: "passed", exitCode: 0, attempts: 1, updatedAt: FINISHED, command: "node scripts/run-gate.mjs heavy", ...job }, log, end });

let out = [], errs = [];
const run = (argv, { env = { OFFICECI_URL: URL_, OFFICECI_TOKEN: TOKEN }, deps } = {}) => {
  out = []; errs = [];
  return main(argv, { root: repo, env, deps, out: (s) => out.push(s), err: (s) => errs.push(s) });
};
const stampFiles = () => ({ heavy: existsSync(heavyStampPath(repo, B)), pre: existsSync(join(mapleDir(repo), "predeploy", "stamps", `${B}.json`)) });
const refused = async (argv, re, opts) => {
  assert.equal(await run(argv, opts), 1);
  assert.match(errs.join("\n"), re);
  assert.ok(!errs.join("\n").includes(TOKEN) && !out.join("\n").includes(TOKEN), "the token is never printed");
  assert.deepEqual(stampFiles(), { heavy: false, pre: false }, "a refused attest writes nothing");
};
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

await t("helpers: repo urls normalize across forms; SSE chunks reassemble in seq order and need an end event", () => {
  for (const u of [ORIGIN, "git@github.com:acme/widgets.git", "ssh://git@GitHub.com/acme/widgets", "https://user@github.com/acme/widgets/"]) assert.equal(normalizeRepoUrl(u), "github.com/acme/widgets");
  const sse = "event: log\ndata: {\"seq\":2,\"text\":\"B\\n\"}\n\nevent: log\ndata: {\"seq\":1,\"text\":\"A\"}\n\nevent: end\ndata: {}\n\n";
  assert.equal(parseSseLog(sse), "AB\n");
  assert.throws(() => parseSseLog("event: log\ndata: {\"seq\":1,\"text\":\"A\"}\n\n"), /without an `end`/);
});

await t("heavy pass: writes the heavy record (local shape) with who=officeci:<job>, via=attest; pays covered debt; token only in the header", async () => {
  mk("hv1", { log: heavyLog(B) });
  recordDebt(repo, { sha: A, step: "live", reason: "docker-unavailable" });
  assert.equal(readDebt(repo).debts.length, 1);
  assert.equal(await run(["attest", "--sha", B, "--officeci-job", "hv1"]), 0, errs.join("\n"));
  const s = readHeavyStamp(repo, B);
  assert.deepEqual(Object.keys(s).sort(), ["at", "sha", "tier", "tree", "via", "who"]);
  assert.equal(s.sha, B); assert.equal(s.tree, TREE_B); assert.equal(s.tier, "heavy"); assert.equal(s.who, "officeci:hv1"); assert.equal(s.via, "attest");
  assert.match(out.join("\n"), /paid 1 gate debt entry/);
  assert.ok(!out.join("\n").includes(TOKEN));
  assert.ok(seen.length >= 2 && seen.every((r) => r.auth === `Bearer ${TOKEN}`));
});

await t("heavy pass is the default kind; --kind heavy is the same", async () => {
  mk("hv2", { log: heavyLog(B) });
  assert.equal(await run(["attest", "--kind", "heavy", "--sha", B, "--officeci-job", "hv2"]), 0, errs.join("\n"));
  assert.equal(readHeavyStamp(repo, B).who, "officeci:hv2");
});

// remove the heavy stamp between failure cases so "writes nothing" is checkable
const { rmSync } = await import("node:fs");
const clear = () => { rmSync(heavyStampPath(repo, B), { force: true }); rmSync(join(mapleDir(repo), "predeploy", "stamps", `${B}.json`), { force: true }); };
clear();

const failCases = [
  ["job failed", { job: { state: "failed", exitCode: 1 }, log: heavyLog(B) }, /did not pass \(state: failed\)/],
  ["job still running", { job: { state: "running", exitCode: null }, log: heavyLog(B) }, /did not pass \(state: running\)/],
  ["passed state but non-zero exit", { job: { exitCode: 2 }, log: heavyLog(B) }, /exit code is 2/],
  ["retried job (attempts > 1)", { job: { attempts: 2 }, log: heavyLog(B) }, /2 attempts/],
  ["different origin repo", { job: { repo: "https://github.com/acme/other.git" }, log: heavyLog(B) }, /ran on repo 'github.com\/acme\/other'/],
  ["job names no repo", { job: { repo: undefined }, log: heavyLog(B) }, /does not name the repo/],
  ["log lacks the heavy success line", { log: `officeci-sha ${B}\nheavy tier passed with 1 SKIPPED step(s)\n` }, /lacks the heavy success line/],
  ["log lacks the officeci-sha line", { log: `${HEAVY_MARKER}\n` }, /lacks an "officeci-sha/],
  ["officeci-sha is another commit", { log: heavyLog(A) }, /is not /],
  ["one officeci-sha matches, a later retry line differs", { log: `officeci-sha ${B}\nofficeci-sha ${A}\n${HEAVY_MARKER}\n` }, /is not |officeci-sha/],
  ["abbreviated officeci-sha", { log: `officeci-sha ${B.slice(0, 10)}\n${HEAVY_MARKER}\n` }, /lacks an "officeci-sha/],
  ["officeci-tree does not match", { log: heavyLog(B) + `officeci-tree ${"0".repeat(40)}\n` }, /officeci-tree/],
  ["log stream cut short (no end event)", { log: heavyLog(B), end: false }, /without an `end`/],
  ["no finish time", { job: { updatedAt: null }, log: heavyLog(B) }, /finish time/],
];
for (const [name, spec, re] of failCases) {
  await t(`heavy refused, nothing written: ${name}`, async () => {
    mk("bad", spec);
    await refused(["attest", "--sha", B, "--officeci-job", "bad"], re);
  });
}

await t("refused: unknown job (404), wrong token (401), unreachable coordinator, missing url/token, bad args", async () => {
  await refused(["attest", "--sha", B, "--officeci-job", "nope"], /HTTP 404/);
  await refused(["attest", "--sha", B, "--officeci-job", "hv1"], /HTTP 401/, { env: { OFFICECI_URL: URL_, OFFICECI_TOKEN: "wrong" } });
  await refused(["attest", "--sha", B, "--officeci-job", "hv1"], /cannot reach/, { env: { OFFICECI_URL: "http://127.0.0.1:9", OFFICECI_TOKEN: TOKEN } });
  await refused(["attest", "--sha", B, "--officeci-job", "hv1"], /no coordinator URL/, { env: { OFFICECI_TOKEN: TOKEN }, deps: { urlStore: () => null } });
  await refused(["attest", "--sha", B, "--officeci-job", "hv1"], /not an http\(s\) URL/, { env: { OFFICECI_URL: "ftp://x", OFFICECI_TOKEN: TOKEN }, deps: { urlStore: () => null } });
  await refused(["attest", "--sha", B, "--officeci-job", "hv1"], /OFFICECI_TOKEN is not set/, { env: { OFFICECI_URL: URL_ }, deps: { store: () => null } });
  await refused(["attest", "--sha", "f".repeat(40), "--officeci-job", "hv1"], /not a commit in this repo/);
  await refused(["attest", "--officeci-job", "hv1"], /--sha is required/);
  await refused(["attest", "--sha", B], /--officeci-job is required/);
  await refused(["attest", "--kind", "live", "--sha", B, "--officeci-job", "hv1"], /--kind must be one of/);
});

await t("coordinator URL sources: env, then Credential Manager officeci-url, then officeci.url in maple.config.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "attest-cfg-"));
  const none = () => null;
  assert.equal(coordinatorUrl(dir, { OFFICECI_URL: "http://env:1/" }, none), "http://env:1", "env alone; trailing slash trimmed");
  assert.equal(coordinatorUrl(dir, {}, () => " http://cred:2/ "), "http://cred:2", "Credential Manager alone");
  writeFileSync(join(dir, "maple.config.json"), JSON.stringify({ officeci: { url: "http://cfg.ts.net:8080/" } }));
  assert.equal(coordinatorUrl(dir, {}, none), "http://cfg.ts.net:8080", "config alone");
  assert.equal(coordinatorUrl(dir, { OFFICECI_URL: "http://env:1" }, () => "http://cred:2"), "http://env:1", "env beats credential and config");
  assert.equal(coordinatorUrl(dir, {}, () => "http://cred:2"), "http://cred:2", "credential beats config");
  assert.equal(coordinatorUrl(dir, {}, none), "http://cfg.ts.net:8080");
  writeFileSync(join(dir, "maple.config.json"), JSON.stringify({ predeploy: {} }));
  assert.throws(() => coordinatorUrl(dir, {}, none), /no coordinator URL/, "none found");
  assert.throws(() => coordinatorUrl(dir, { OFFICECI_URL: "ftp://x" }, none), /not an http\(s\) URL/);
  assert.throws(() => coordinatorUrl(dir, {}, () => "javascript:alert(1)"), /not an http\(s\) URL/, "invalid from the credential store");
  writeFileSync(join(dir, "maple.config.json"), JSON.stringify({ officeci: { url: "file:///etc/passwd" } }));
  assert.throws(() => coordinatorUrl(dir, {}, none), /not an http\(s\) URL/, "invalid from config");
});

await t("attest end to end via each URL source (local HTTP stub); the token is never printed; no flag can redirect", async () => {
  const cfg = join(repo, "maple.config.json");
  const before = readFileSync(cfg, "utf8");
  const ok = async (id, o) => { mk(id, { log: heavyLog(B) }); assert.equal(await run(["attest", "--sha", B, "--officeci-job", id], o), 0, errs.join("\n")); assert.equal(readHeavyStamp(repo, B).who, `officeci:${id}`); assert.ok(!out.join("\n").includes(TOKEN)); clear(); };
  await ok("src-env", { env: { OFFICECI_URL: URL_, OFFICECI_TOKEN: TOKEN }, deps: { urlStore: () => { throw new Error("not consulted when env is set"); } } });
  await ok("src-cred", { env: { OFFICECI_TOKEN: TOKEN }, deps: { urlStore: () => URL_ } });
  writeFileSync(cfg, JSON.stringify({ predeploy: { stampTtlHours: 72 }, officeci: { url: URL_ } }));
  await ok("src-cfg", { env: { OFFICECI_TOKEN: TOKEN }, deps: { urlStore: () => null } });
  // precedence over the wire: a dead env URL wins over a live config URL and so fails to connect
  await refused(["attest", "--sha", B, "--officeci-job", "src-cfg"], /cannot reach/, { env: { OFFICECI_URL: "http://127.0.0.1:9", OFFICECI_TOKEN: TOKEN }, deps: { urlStore: () => URL_ } });
  // command-line flags are not a source for the URL: the config's wins, an unknown flag is ignored
  mk("src-flag", { log: heavyLog(B) });
  assert.equal(await run(["attest", "--sha", B, "--officeci-job", "src-flag", "--url", "http://127.0.0.1:9", "--officeci-url", "http://127.0.0.1:9"], { env: { OFFICECI_TOKEN: TOKEN }, deps: { urlStore: () => null } }), 0, errs.join("\n"));
  clear();
  writeFileSync(cfg, before);
});

await t("credentialFromStore reads the officeci-url target through the injected runner", () => {
  if (process.platform !== "win32") return;
  const seenPs = [];
  const run1 = (_c, args) => { seenPs.push(args.at(-1)); return { status: 0, stdout: "http://cm:3" }; };
  assert.equal(credentialFromStore(URL_CRED_TARGETS, run1), "http://cm:3");
  assert.match(seenPs[0], /-Target 'officeci-url'/);
});

await t("the token falls back to Credential Manager (injected store)", async () => {
  mk("hv3", { log: heavyLog(B) });
  assert.equal(await run(["attest", "--sha", B, "--officeci-job", "hv3"], { env: { OFFICECI_URL: URL_ }, deps: { store: () => TOKEN } }), 0, errs.join("\n"));
  clear();
});

await t("predeploy pass: writes the predeploy stamp, 72h from the job's finish time, who=officeci:<job>, via=attest", async () => {
  mk("pd1", { job: { command: "node $P/scripts/predeploy/run.mjs --root ." }, log: predeployLog(B) });
  assert.equal(await run(["attest", "--kind", "predeploy", "--sha", B, "--officeci-job", "pd1"]), 0, errs.join("\n"));
  const s = JSON.parse(readFileSync(join(mapleDir(repo), "predeploy", "stamps", `${B}.json`), "utf8"));
  assert.equal(s.status, "pass"); assert.equal(s.sha, B); assert.equal(s.tree, TREE_B);
  assert.equal(s.issuedAt, new Date(FINISHED).toISOString());
  assert.equal(s.expiresAt, new Date(FINISHED + 72 * 3600000).toISOString());
  assert.equal(s.who, "officeci:pd1"); assert.equal(s.via, "attest");
  for (const k of ["configHash", "allowlistHash", "decisionsHash", "version"]) assert.ok(s[k] !== undefined, k);
  assert.ok(!existsSync(heavyStampPath(repo, B)), "a predeploy attest never writes a heavy record");
  clear();
});

const pdFail = [
  ["no STAMP ISSUED line", predeployLog(B).replace(/STAMP ISSUED.*\n/, ""), {}, /STAMP ISSUED/],
  ["GATE FAILED in the log", predeployLog(B) + "GATE FAILED: 2 blocking finding(s) across 1 check(s). No stamp.\n", {}, /GATE FAILED/],
  ["a check shows blocking findings", predeployLog(B).replace("trivy-fs   blocking=0", "trivy-fs   blocking=3"), {}, /blocking findings/],
  ["no per-check result lines", `officeci-sha ${B}\nSTAMP ISSUED for ${B.slice(0, 8)} (valid 72h)\n`, {}, /zero findings/],
  ["a --live run", predeployLog(B), { command: "node run.mjs --live" }, /--live/],
  ["a partial run (--check)", predeployLog(B), { command: "node run.mjs --check gitleaks" }, /partial/],
  ["officeci-sha is another commit", predeployLog(A), {}, /is not /],
  ["heavy log offered as predeploy", heavyLog(B), {}, /STAMP ISSUED/],
];
for (const [name, log, job, re] of pdFail) {
  await t(`predeploy refused, nothing written: ${name}`, async () => {
    mk("pdbad", { job, log });
    await refused(["attest", "--kind", "predeploy", "--sha", B, "--officeci-job", "pdbad"], re);
  });
}

await t("predeploy refused when --sha is not HEAD or the tree is dirty; a predeploy log is not a heavy pass", async () => {
  mk("pd2", { log: predeployLog(A) });
  await refused(["attest", "--kind", "predeploy", "--sha", A, "--officeci-job", "pd2"], /HEAD of this checkout/);
  mk("pd3", { log: predeployLog(B) });
  writeFileSync(join(repo, "b"), "dirty");
  await refused(["attest", "--kind", "predeploy", "--sha", B, "--officeci-job", "pd3"], /differ from HEAD/);
  g("checkout", "--", "b");
  await refused(["attest", "--sha", B, "--officeci-job", "pd3"], /heavy success line/);
});

server.close();
console.log(`\nall ${n} attest tests passed`);
