// Preflight: the gate's fast verdicts, run first. One throwaway git repo + bare origin; tools, Docker, credentials and
// gh are faked through the seams, so nothing here touches Docker, the network or the credential store.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gatePreflight } from "./gate-preflight.mjs";
import { selfHostedLabelSets } from "./remote.mjs";
import { normalize } from "./config.mjs";
import { loadAllowlist } from "./allowlist.mjs";
import { loadDecisions } from "./decisions.mjs";
import { loadImageDebt } from "./imagedebt.mjs";
import { headSha } from "./lib.mjs";
import { reportPath } from "./state.mjs";
import { main as runGate } from "./run.mjs";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };
const base = mkdtempSync(join(tmpdir(), "predeploy-preflight-"));
const origin = join(base, "origin.git");
const repo = join(base, "repo");
const g = (args, cwd = repo) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, args.join(" ") + r.stderr); return r.stdout.trim(); };
spawnSync("git", ["init", "-q", "--bare", origin]);
spawnSync("git", ["init", "-q", repo]);
g(["config", "user.email", "t@t"]); g(["config", "user.name", "t"]); g(["config", "commit.gpgsign", "false"]);
g(["checkout", "-q", "-b", "main"]); g(["remote", "add", "origin", origin]);

const LEDGER = "# Decisions\n\n## D161 | 2026-10-01 | Test exception decision\nbody\n";
const OPT_OUT = { optOut: { bundle: { decision: "D161", why: "fixture repo: no web build to scan (the D072 opt-out path)" } } };
const OK = { id: "ok", command: 'node -e "process.exit(0)"' };
const cfgOf = (checks, extra = {}) => ({ project: { name: "t", slug: "t" }, predeploy: { checks, exposure: OPT_OUT, ...extra } });
const WORKFLOW = "name: r\non: push\njobs:\n  build:\n    runs-on: [self-hosted, docker, acme]\n    steps:\n      - run: echo\n";
const commit = (cfg, files = {}) => {
  writeFileSync(join(repo, "maple.config.json"), JSON.stringify(cfg, null, 2));
  for (const [k, v] of Object.entries({ "docs/decisions.md": LEDGER, ".github/workflows/w.yml": WORKFLOW, ...files })) {
    mkdirSync(dirname(join(repo, k)), { recursive: true }); writeFileSync(join(repo, k), v);
  }
  g(["add", "-A"]); g(["commit", "-q", "-m", "c", "--allow-empty"]);
  return cfg;
};

// Seams: everything present by default.
const OK_RESOLVE = (name) => ({ name, mode: "native", version: "fake", bin: name });
const UP = () => ({ ok: true, detail: "fake" });
const fakeGh = ({ runs = [], runners = null, apiStatus = 0 } = {}) => async (_root, args) => {
  if (args[0] === "run" && args[1] === "list") return { status: 0, out: JSON.stringify(runs), err: "" };
  if (args[0] === "repo") return { status: 0, out: "o/r", err: "" };
  if (args[0] === "api") return apiStatus ? { status: 1, out: "", err: "HTTP 403: Resource not accessible by integration" } : { status: 0, out: JSON.stringify({ runners: runners || [] }), err: "" };
  return { status: 1, out: "", err: "unexpected" };
};
const runner = (status) => ({ name: "box", status, busy: false, labels: ["self-hosted", "docker", "acme", "X64"].map((name) => ({ name })) });

const pf = (cfg, o = {}) => {
  const pd = normalize(cfg);
  return gatePreflight({
    root: repo, pd, sha: headSha(repo), selected: o.selected || pd.checks, subset: Boolean(o.subset), rebaseline: Boolean(o.rebaseline),
    allowDirty: Boolean(o.allowDirty), al: loadAllowlist(repo, pd.allowlist), dl: loadDecisions(repo, pd.decisions),
    idl: pd.imageDebt ? loadImageDebt(repo, pd.imageDebt.file) : null,
    resolve: o.resolve || OK_RESOLVE, docker: o.docker || UP, credExists: o.credExists || (() => true), gh: o.gh || fakeGh(),
  });
};
const ids = (r) => r.failures.map((f) => `${f.check}:${f.id}`);
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

await t("a clean candidate passes in well under the gate's minutes", async () => {
  commit(cfgOf([OK]));
  const r = await pf(cfgOf([OK]));
  assert.deepEqual(ids(r), []); assert.equal(r.ok, true);
  assert.ok(r.ms < 5000, `${r.ms}ms`);
});

await t("dirty tracked tree fails (unless --allow-dirty)", async () => {
  writeFileSync(join(repo, "maple.config.json"), JSON.stringify(cfgOf([OK]), null, 1));
  assert.deepEqual(ids(await pf(cfgOf([OK]))), ["git:working-tree-dirty"]);
  assert.deepEqual(ids(await pf(cfgOf([OK]), { allowDirty: true })), []);
  g(["checkout", "--", "maple.config.json"]);
});

await t("exception files: expired allowlist row, uncommitted allowlist, decision missing from the ledger", async () => {
  const al = (expires) => JSON.stringify({ version: 1, entries: [{ check: "ok", id: "x", reason: "a reason long enough", owner: "me", expires }] });
  commit(cfgOf([OK]), { "predeploy-allowlist.json": al("2020-01-01") });
  assert.deepEqual(ids(await pf(cfgOf([OK]))), ["allowlist:allowlist-expired"]);
  writeFileSync(join(repo, "predeploy-allowlist.json"), al(inDays(10)));
  assert.deepEqual(ids(await pf(cfgOf([OK]), { allowDirty: true })), ["allowlist:allowlist-uncommitted"]);
  g(["rm", "-q", "-f", "predeploy-allowlist.json"]);
  const dec = { version: 1, entries: [{ scanner: "ok", rule: "x", scope: "a.ts", decision: "D999", why: "cannot be fixed because reasons", reviewed: inDays(-1) }] };
  commit(cfgOf([OK]), { "predeploy-decisions.json": JSON.stringify(dec) });
  assert.deepEqual(ids(await pf(cfgOf([OK]))), ["decisions:decision-missing"]);
  g(["rm", "-q", "predeploy-decisions.json"]); commit(cfgOf([OK]));
});

const TRIVY = { id: "trivy-images", preset: "trivy-image", options: { images: [{ name: "mysql", ref: "mysql:8@sha256:aa" }] } };
await t("image debt: a pinned third-party image missing from the debt file fails; a re-baseline run is not blocked by it", async () => {
  const cfg = commit(cfgOf([TRIVY], { imageDebt: { ownImages: [] } }));
  assert.deepEqual(ids(await pf(cfg)), ["image-debt:image-debt-unlisted"]);
  assert.deepEqual(ids(await pf(cfg, { rebaseline: true, subset: true })), []);
});

await t("unpaid live-scan debt fails a full run; subset runs skip it (as the gate does)", async () => {
  const cfg = commit(cfgOf([OK], { liveScan: { enabled: true } }));
  const r = await pf(cfg);
  assert.deepEqual(ids(r), ["live-scan:live-scan-debt"]); assert.match(r.failures[0].message, /no live scan has ever been recorded/);
  assert.deepEqual(ids(await pf(cfg, { subset: true })), []);
});

const REMOTE = { id: "clean-room", github: "w.yml", why: "needs the self-hosted docker box to build the release" };
const RCFG = cfgOf([OK, REMOTE], { remote: { workflow: "w.yml" } });
await t("remote leg: branch not pushed fails; detached HEAD fails", async () => {
  commit(RCFG);
  assert.deepEqual(ids(await pf(RCFG, { gh: fakeGh({ runners: [runner("online")] }) })), ["clean-room:sha-not-on-remote"]);
  g(["checkout", "-q", "--detach"]);
  assert.deepEqual(ids(await pf(RCFG)), ["clean-room:remote-ref-unknown"]);
  g(["checkout", "-q", "main"]);
  assert.deepEqual(ids(await pf(RCFG, { selected: [OK] })), [], "not selected = not judged");
});

await t("remote leg: runner offline fails; online passes; a reusable green run needs no runner; an unreadable runner list only warns", async () => {
  g(["push", "-q", "origin", "main"]);
  const off = await pf(RCFG, { gh: fakeGh({ runners: [runner("offline")] }) });
  assert.deepEqual(ids(off), ["clean-room:runner-offline"]); assert.match(off.failures[0].message, /1 registered, all offline \(box\)/);
  assert.deepEqual(ids(await pf(RCFG, { gh: fakeGh({ runners: [runner("offline"), runner("online")] }) })), []);
  const reuse = await pf(RCFG, { gh: fakeGh({ runs: [{ headSha: headSha(repo), status: "completed", conclusion: "success" }], runners: [runner("offline")] }) });
  assert.deepEqual(ids(reuse), []); assert.match(reuse.notes.join(), /will be reused/);
  const forbidden = await pf(RCFG, { gh: fakeGh({ apiStatus: 403 }) });
  assert.deepEqual(ids(forbidden), []); assert.match(forbidden.warnings.join(), /cannot list o\/r runners .*403/);
  const unmatched = await pf(RCFG, { gh: fakeGh({ runners: [{ name: "other", status: "offline", labels: [{ name: "self-hosted" }] }] }) });
  assert.deepEqual(ids(unmatched), []); assert.match(unmatched.warnings.join(), /no repo-level runner carries/);
});

await t("tools: a missing tool fails as tool-missing; the check's severity floor applies as in the gate", async () => {
  const cfg = commit(cfgOf([{ id: "sg", preset: "semgrep" }]));
  const missing = (name) => (name === "semgrep" ? { name, mode: "missing", reason: "semgrep not installed" } : OK_RESOLVE(name));
  const r = await pf(cfg, { resolve: missing });
  assert.deepEqual(ids(r), ["sg:tool-missing"]); assert.match(r.failures[0].message, /semgrep not installed\. Install:/);
  assert.deepEqual(ids(await pf(cfgOf([{ id: "sg", preset: "semgrep", minSeverity: "critical" }]), { resolve: missing })), []);
  // A plain command check's declared tools are never resolved by the gate (its verdict is exit 127): a warning only.
  const cmd = await pf(cfgOf([{ id: "c", command: "semgrep scan", tools: ["semgrep"] }]), { resolve: missing });
  assert.deepEqual(ids(cmd), []); assert.match(cmd.warnings.join(), /c: declared tool semgrep is not runnable/);
});

await t("Docker: a check that drives Docker fails fast when the daemon is down", async () => {
  const cfg = commit(cfgOf([TRIVY], { imageDebt: undefined }));
  const r = await pf(cfg, { docker: () => ({ ok: false, detail: "docker daemon not reachable" }) });
  assert.deepEqual(ids(r), ["trivy-images:docker-unreachable"]);
  assert.deepEqual(ids(await pf(cfgOf([OK]), { docker: () => ({ ok: false }) })), [], "no Docker check, no Docker verdict");
});

await t("credentials: a preset's token missing from the store fails (presence only)", async () => {
  const ADV = { id: "advisors", preset: "supabase-advisors", options: { projectRef: "abc" } };
  const cfg = commit(cfgOf([ADV]));
  const asked = [];
  const r = await pf(cfg, { credExists: (target) => { asked.push(target); return false; } });
  assert.deepEqual(ids(r), ["advisors:token-missing"]); assert.deepEqual(asked, ["Supabase-PAT"]);
  process.env.SUPABASE_ACCESS_TOKEN = "x";
  try { assert.deepEqual(ids(await pf(cfg, { credExists: () => false })), []); } finally { delete process.env.SUPABASE_ACCESS_TOKEN; }
});

const quiet = async (fn) => {
  const lines = []; const log = console.log; const err = console.error;
  console.log = (...a) => lines.push(a.join(" ")); console.error = (...a) => lines.push(a.join(" "));
  try { return { code: await fn(), text: lines.join("\n") }; } finally { console.log = log; console.error = err; }
};
const SEAMS = { preflightSeams: { resolve: OK_RESOLVE, docker: UP, credExists: () => true, gh: fakeGh() } };

await t("the gate stops in the preflight: exit 1, a preflight report, no scanner started", async () => {
  const MARK = { id: "marker", command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'1\')"' };
  const al = JSON.stringify({ version: 1, entries: [{ check: "marker", id: "x", reason: "a reason long enough", owner: "me", expires: "2020-01-01" }] });
  commit(cfgOf([MARK]), { "predeploy-allowlist.json": al });
  const r = await quiet(() => runGate(["--root", repo], SEAMS));
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /PREFLIGHT FAIL \[allowlist\] allowlist-expired/); assert.match(r.text, /GATE FAILED IN PREFLIGHT/);
  assert.ok(!existsSync(join(repo, "ran.txt")), "no check ran");
  const rep = JSON.parse(readFileSync(reportPath(repo, headSha(repo)), "utf8"));
  assert.equal(rep.stage, "preflight"); assert.equal(rep.status, "fail"); assert.deepEqual(rep.blocking.map((f) => f.id), ["allowlist-expired"]);
});

await t("`run.mjs preflight` runs only the fast verdicts: exit 1 with one line per failure, exit 0 when clean", async () => {
  const r = await quiet(() => runGate(["preflight", "--root", repo], SEAMS));
  assert.equal(r.code, 1); assert.match(r.text, /^preflight — 1 failure\(s\) in [\d.]+s/m);
  assert.equal(r.text.split("\n").filter((l) => l.includes("PREFLIGHT FAIL")).length, 1);
  assert.ok(!existsSync(join(repo, "ran.txt")));
  g(["rm", "-q", "predeploy-allowlist.json"]); commit(cfgOf([OK]));
  const ok = await quiet(() => runGate(["preflight", "--root", repo, "--json"], SEAMS));
  assert.equal(ok.code, 0, ok.text); assert.equal(JSON.parse(ok.text).ok, true);
});

await t("a full clean gate run records the preflight and real per-check timing in its report", async () => {
  const r = await quiet(() => runGate(["--root", repo], SEAMS));
  assert.equal(r.code, 0, r.text);
  const rep = JSON.parse(readFileSync(reportPath(repo, headSha(repo)), "utf8"));
  assert.equal(rep.preflight.ok, true); assert.equal(typeof rep.timing.wallMs, "number");
  const c = rep.checks[0];
  assert.ok(Date.parse(c.endedAt) >= Date.parse(c.startedAt) && c.ms === Date.parse(c.endedAt) - Date.parse(c.startedAt), JSON.stringify(c));
});

await t("runs-on parsing: inline list, scalar, block list, group labels, expressions, GitHub-hosted", () => {
  assert.deepEqual(selfHostedLabelSets(WORKFLOW).sets, [["self-hosted", "docker", "acme"]]);
  assert.deepEqual(selfHostedLabelSets("jobs:\n  a:\n    runs-on: self-hosted\n").sets, [["self-hosted"]]);
  assert.deepEqual(selfHostedLabelSets("jobs:\n  a:\n    runs-on:\n      - self-hosted\n      - 'gpu'\n    steps: []\n").sets, [["self-hosted", "gpu"]]);
  assert.deepEqual(selfHostedLabelSets("jobs:\n  a:\n    runs-on:\n      group: g\n      labels: [self-hosted, big]\n").sets, [["self-hosted", "big"]]);
  assert.equal(selfHostedLabelSets("jobs:\n  a:\n    runs-on: ${{ matrix.os }}\n").unknown, true);
  assert.deepEqual(selfHostedLabelSets("jobs:\n  a:\n    runs-on: ubuntu-latest\n").sets, []);
});

rmSync(base, { recursive: true, force: true });
console.log(`\n${n} preflight tests passed`);
