// Fast lane (deploy first, enforce after), end to end: throwaway git repos with a bare `origin` (so "pushed" is real),
// the real guard hook process, the real CLI, and (where a case needs a genuinely valid stamp) the real gate runner.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as runGate } from "./run.mjs";
import { headSha, which } from "./lib.mjs";
import { readLedger, stampPath, verifyStamp, writeJson } from "./state.mjs";
import { openDebt, permit, permitFile, readDebts, secretScan, status, verifyDeploy } from "./fastlane.mjs";
import { recordDebt, writeHeavyStamp } from "../gate/gate-state.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "..", "hooks", "guard.mjs");
const CLI = join(HERE, "fastlane-cli.mjs");
const CLI_FWD = CLI.replace(/\\/g, "/");
const HOUR = 3600000;

const dirs = [];
const stub = { secretScan: () => ({ ok: true, reason: "stub" }) };
const FIXTURE_LEDGER = "# Decisions\n\n## D161 | 2026-10-01 | Test exception decision\nbody\n";
const cfgOf = (fastLane) => ({
  project: { name: "t", slug: "t" },
  predeploy: {
    checks: [{ id: "ok", command: 'node -e "process.exit(0)"' }],
    deployGuard: { patterns: [{ id: "dep", regex: "(^|[\\s/\\\\])deploy\\.sh\\b" }] },
    exposure: { optOut: { bundle: { decision: "D161", why: "fixture repo: no web build to scan (the D072 opt-out path)" } } },
    ...(fastLane ? { fastLane } : {}),
  },
});
const FL = { enabled: true, allow: ["src/**", "docs/**"] };

/** A fresh repo + bare origin whose first commit is "fully stamped" (heavy + predeploy) and pushed. */
function mk(opts = {}) {
  const fastLane = "fastLane" in opts ? opts.fastLane : FL; // `fastLane: undefined` means "no block at all"
  const dir = mkdtempSync(join(tmpdir(), "fastlane-it-"));
  dirs.push(dir);
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const run = (args, cwd) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, args.join(" ") + "\n" + r.stdout + r.stderr); return r.stdout.trim(); };
  run(["init", "-q", "--bare", "-b", "main", origin], dir);
  run(["init", "-q", "-b", "main"], repo);
  for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"]]) run(["config", k, v], repo);
  run(["remote", "add", "origin", origin], repo);
  const sh = (...args) => run(args, repo);
  let seq = 0;
  const fx = {
    repo, origin, sh,
    head: () => headSha(repo),
    write(files) { for (const [k, v] of Object.entries(files)) { mkdirSync(dirname(join(repo, k)), { recursive: true }); writeFileSync(join(repo, k), v); } },
    commit(files, { branch = "main", push = true } = {}) {
      fx.write(files); sh("add", "-A"); sh("commit", "-q", "-m", "c" + ++seq, "--allow-empty");
      if (push) sh("push", "-q", "origin", `HEAD:refs/heads/${branch}`);
      return fx.head();
    },
    /** What the project's own gate tier leaves behind for a tree (prepush-lib.sh pp_stamp_write). */
    gatePass(sha = fx.head()) {
      const tree = sh("rev-parse", `${sha}^{tree}`);
      const d = join(repo, ".git", "ci-gate-pass");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `gate-${tree}`), `at ${new Date().toISOString()}\nmode full\n`);
    },
    /** Minimal heavy + predeploy pass records: all the lane's base / payment logic reads (status + sha). */
    stamp(sha = fx.head(), { heavy = true, predeploy = true } = {}) {
      if (heavy) writeHeavyStamp(repo, sha);
      if (predeploy) writeJson(stampPath(repo, sha), { sha, status: "pass", issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 72 * HOUR).toISOString() });
    },
    /** An eligible commit on top of HEAD, pushed, gate tier green. */
    change(file = "src/a.ts") { const s = fx.commit({ [file]: `export const v = ${++seq};\n` }); fx.gatePass(s); return s; },
    permit: (opts = {}) => permit(repo, { deps: stub, ...opts }),
    hook(command, tool = "Bash", extra = {}) {
      return spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: { command, ...extra }, cwd: repo }), encoding: "utf8" });
    },
    cli(...args) { return spawnSync(process.execPath, [CLI, ...args, "--root", repo], { encoding: "utf8" }); },
    debtFile: () => join(repo, ".git", "maple", "predeploy", "fast-lane", "debt.jsonl"),
    debts: () => readDebts(repo),
    /** Run the real gate on HEAD (valid stamp: config hash, allowlist, ...) and give it a heavy stamp. */
    async realStamp() {
      const log = console.log; console.log = () => {};
      let code;
      try { code = await runGate(["--root", repo]); } finally { console.log = log; }
      assert.equal(code, 0, "the real gate must stamp the fixture commit");
      writeHeavyStamp(repo, fx.head());
    },
  };
  fx.commit({ "maple.config.json": JSON.stringify(cfgOf(fastLane), null, 2), "docs/decisions.md": FIXTURE_LEDGER, "src/a.ts": "export const v = 0;\n" });
  fx.stamp();
  fx.base = fx.head();
  return fx;
}
const out = (r) => (r.stdout || "") + (r.stderr || "");
/** Deploy once under a fresh permit via the real hook: leaves one open debt on the new HEAD. */
function deployFast(fx, file) {
  const sha = fx.change(file);
  assert.equal(fx.permit().ok, true);
  const r = fx.hook("bash deploy.sh");
  assert.equal(r.status, 0, out(r));
  return sha;
}
const rewriteDeadline = (fx, iso) => {
  const lines = readFileSync(fx.debtFile(), "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  writeFileSync(fx.debtFile(), lines.map((l) => JSON.stringify(l.type === "debt" ? { ...l, deadline: iso } : l)).join("\n") + "\n");
};

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

// ── a. lane off ─────────────────────────────────────────────────────────────
await t("a. lane disabled (absent, or enabled:false): permit refuses and the hook behaves exactly as before", async () => {
  for (const fastLane of [undefined, { enabled: false, allow: ["src/**"] }]) {
    const fx = mk({ fastLane });
    fx.change("src/a.ts");
    const p = fx.permit();
    assert.equal(p.ok, false); assert.match(p.failures[0], /not enabled/);
    assert.ok(!existsSync(permitFile(fx.repo)));
    const r = fx.hook("bash deploy.sh");
    assert.equal(r.status, 2, out(r)); assert.match(r.stderr, /no predeploy stamp/);
    assert.doesNotMatch(r.stderr, /Fast lane/);
    assert.equal(fx.cli("permit").status, 1);
    assert.equal(status(fx.repo).enabled, false);
    assert.equal(fx.cli("status").status, 0);
  }
});

// ── b. the happy path ───────────────────────────────────────────────────────
await t("b. eligible diff: permit, deploy under a warning, one debt, permit spent, multi-step deploy adds no second debt", () => {
  const fx = mk();
  const sha = fx.change("src/a.ts");
  const chk = fx.cli("check", "--json");
  assert.equal(chk.status, 0, out(chk)); assert.equal(JSON.parse(chk.stdout).ok, true);
  assert.ok(!existsSync(permitFile(fx.repo)), "check writes nothing");
  const p = fx.permit();
  assert.equal(p.ok, true, JSON.stringify(p)); assert.equal(p.sha, sha); assert.equal(p.base, fx.base); assert.equal(p.files, 1);
  assert.ok(existsSync(permitFile(fx.repo)));

  const r = fx.hook("bash deploy.sh");
  assert.equal(r.status, 0, out(r)); assert.match(out(r), /FAST LANE/);
  const debts = fx.debts();
  assert.equal(debts.length, 1);
  const d = debts[0];
  assert.equal(d.sha, sha); assert.equal(d.base, fx.base); assert.equal(d.closed, null);
  assert.ok(d.at && d.deadline);
  assert.ok(Math.abs(new Date(d.deadline) - new Date(d.at) - 12 * HOUR) < 1000, "deadline is +12h");
  const led = readLedger(fx.repo);
  assert.equal(led.length, 1); assert.equal(led[0].lane, "fast"); assert.equal(led[0].sha, sha);
  assert.ok(!existsSync(permitFile(fx.repo)), "the permit is spent");

  const r2 = fx.hook("bash deploy.sh");
  assert.equal(r2.status, 0, out(r2));
  assert.equal(fx.debts().length, 1, "a second step of the same deploy records no second debt");
  assert.equal(readLedger(fx.repo).filter((e) => e.lane === "fast").length, 2);
  assert.equal(fx.hook("node --version").status, 0, "non-deploy commands are untouched");
});

// ── c. denied / unclassified paths ──────────────────────────────────────────
await t("c. a denied path (migration) and an unclassified path (scripts/unknown.txt) refuse the permit and the deploy", () => {
  for (const [file, re] of [["supabase/migrations/001.sql", /database migration/], ["scripts/unknown.txt", /unclassified/]]) {
    const fx = mk();
    const s = fx.commit({ [file]: "x\n", "src/a.ts": "export const v = 9;\n" });
    fx.gatePass(s);
    const p = fx.permit();
    assert.equal(p.ok, false, file);
    const hit = p.denied.find((d) => d.path === file);
    assert.ok(hit, file + " listed in denied: " + JSON.stringify(p.denied)); assert.match(hit.reason, re);
    assert.equal(p.denied.length, 1, "the allowed src/a.ts is not listed as denied");
    assert.ok(!existsSync(permitFile(fx.repo)));
    const c = fx.cli("check");
    assert.equal(c.status, 1); assert.match(c.stdout, new RegExp(file.replace(/[./]/g, "\\$&")));
    const r = fx.hook("bash deploy.sh");
    assert.equal(r.status, 2, out(r)); assert.equal(fx.debts().length, 0);
  }
});

// ── d. each precondition alone ──────────────────────────────────────────────
await t("d. each precondition refuses on its own (dirty tree, not pushed, no gate stamp, gate debt, secret scan)", () => {
  const only = (p, re) => { assert.equal(p.ok, false); assert.equal(p.failures.length, 1, JSON.stringify(p.failures)); assert.match(p.failures[0], re); assert.ok(!existsSync(permitFile(p.repo))); };
  { // dirty tracked tree
    const fx = mk(); fx.change("src/a.ts"); fx.write({ "src/a.ts": "// dirty\n" });
    const p = fx.permit(); p.repo = fx.repo; only(p, /tracked files differ from HEAD/);
  }
  { // HEAD not pushed
    const fx = mk(); const s = fx.commit({ "src/a.ts": "export const v = 2;\n" }, { push: false }); fx.gatePass(s);
    const p = fx.permit(); p.repo = fx.repo; only(p, /not on any remote branch/);
    fx.sh("push", "-q", "origin", "HEAD:refs/heads/main");
    assert.equal(fx.permit().ok, true, "pushing clears it");
  }
  { // no gate stamp for this tree
    const fx = mk(); fx.commit({ "src/a.ts": "export const v = 3;\n" });
    const p = fx.permit(); p.repo = fx.repo; only(p, /gate-tier pass stamp/);
  }
  { // a stamp for a DIFFERENT tree does not count
    const fx = mk(); fx.gatePass(fx.base); fx.commit({ "src/a.ts": "export const v = 3;\n" });
    const p = fx.permit(); p.repo = fx.repo; only(p, /gate-tier pass stamp/);
  }
  { // unpaid gate debt
    const fx = mk(); const s = fx.change("src/a.ts");
    recordDebt(fx.repo, { sha: s, step: "live", reason: "docker-unavailable" });
    const p = fx.permit(); p.repo = fx.repo; only(p, /unpaid gate debt/);
  }
  { // secret scan
    const fx = mk(); fx.change("src/a.ts");
    const p = fx.permit({ deps: { secretScan: () => ({ ok: false, reason: "1 secret finding" }) } }); p.repo = fx.repo; only(p, /1 secret finding/);
  }
  { // custom gate tier names are honoured
    const fx = mk({ fastLane: { ...FL, gateTiers: ["fast"] } }); fx.change("src/a.ts");
    assert.equal(fx.permit().ok, false, "only a `gate-` stamp exists, the project says `fast`");
  }
});

// ── e. one at a time ────────────────────────────────────────────────────────
await t("e. while a debt is open: a second fast deploy and an unrelated fully stamped commit are both refused, naming the way out", async () => {
  const fx = mk();
  const debtSha = deployFast(fx, "src/a.ts");
  const d = fx.debts()[0];
  fx.change("src/b.ts");
  const p = fx.permit();
  assert.equal(p.ok, false); assert.match(p.failures.join("\n"), /only one at a time/); assert.match(p.failures.join("\n"), new RegExp(debtSha.slice(0, 8)));
  const r = fx.hook("bash deploy.sh");
  assert.equal(r.status, 2, out(r));
  assert.match(r.stderr, new RegExp(debtSha.slice(0, 8))); assert.match(r.stderr, new RegExp(d.deadline.replace(/[.]/g, "\\.")));
  assert.match(r.stderr, /FIX FORWARD/); assert.match(r.stderr, /ROLL BACK/); assert.match(r.stderr, new RegExp(fx.base.slice(0, 8)));
  assert.equal(fx.debts().length, 1);

  // a genuinely valid, fully stamped commit that does NOT contain the indebted one
  fx.sh("checkout", "-q", "-b", "side", fx.base);
  fx.commit({ "src/side.ts": "export const s = 1;\n" }, { branch: "side" });
  await fx.realStamp();
  assert.equal(verifyStamp(fx.repo).ok, true, "precondition: the side commit is fully valid on its own: " + verifyStamp(fx.repo).reason);
  const r2 = fx.hook("bash deploy.sh");
  assert.equal(r2.status, 2, out(r2)); assert.match(r2.stderr, /does not contain the indebted commit/); assert.match(r2.stderr, /FIX FORWARD/);
  assert.equal(fx.debts().length, 1); assert.equal(fx.debts()[0].closed, null);
});

// ── f. paying the debt ──────────────────────────────────────────────────────
await t("f. a stamped descendant pays the debt (closed `paid`), then a new round can start", () => {
  const fx = mk();
  const debtSha = deployFast(fx, "src/a.ts");
  assert.equal(status(fx.repo).state, "owed");
  const desc = fx.commit({ "src/c.ts": "export const c = 1;\n" });
  fx.stamp(desc);
  assert.equal(status(fx.repo).state, "clear");
  const d = fx.debts()[0];
  assert.equal(d.sha, debtSha); assert.equal(d.closed.how, "paid"); assert.equal(d.closed.heavy, desc); assert.equal(d.closed.predeploy, desc);
  assert.equal(openDebt(fx.repo), null);
  fx.change("src/d.ts");
  const p = fx.permit();
  assert.equal(p.ok, true, JSON.stringify(p)); assert.equal(p.base, desc, "the paid descendant is the new proven base");
  assert.equal(fx.hook("bash deploy.sh").status, 0);
  assert.equal(fx.debts().length, 2);
});

await t("f2. with a debt open, a REAL fully stamped descendant may deploy (lane full) and settles the debt", async () => {
  const fx = mk();
  const debtSha = deployFast(fx, "src/a.ts");
  fx.commit({ "src/e.ts": "export const e = 1;\n" });
  assert.equal(fx.hook("bash deploy.sh").status, 2, "not stamped yet");
  await fx.realStamp();
  const r = fx.hook("bash deploy.sh");
  assert.equal(r.status, 0, out(r));
  const led = readLedger(fx.repo);
  assert.equal(led[led.length - 1].lane, "full");
  assert.equal(fx.debts()[0].sha, debtSha); assert.equal(fx.debts()[0].closed.how, "paid");
});

await t("g. a partial payment keeps the debt open and says what is still owed", () => {
  const fx = mk();
  deployFast(fx, "src/a.ts");
  const desc = fx.commit({ "src/c.ts": "export const c = 1;\n" });
  fx.stamp(desc, { predeploy: false });
  let d = openDebt(fx.repo);
  assert.deepEqual(d.owes, ["predeploy"]); assert.equal(status(fx.repo).state, "owed"); assert.deepEqual(status(fx.repo).action.run, ["predeploy"]);
  rmSync(join(fx.repo, ".git", "maple", "heavy-pass", `${desc}.json`));
  fx.stamp(desc, { heavy: false });
  d = openDebt(fx.repo);
  assert.deepEqual(d.owes, ["heavy"]);
  fx.stamp(desc, { predeploy: false });
  assert.equal(openDebt(fx.repo), null);
});

// ── h. overdue ──────────────────────────────────────────────────────────────
await t("h. overdue: in-process and through the real hook; the CLI status exit codes 0 / 10 / 11 and the --json action", () => {
  const clear = mk();
  assert.equal(clear.cli("status").status, 0);

  const fx = mk();
  const debtSha = deployFast(fx, "src/a.ts");
  let s = fx.cli("status");
  assert.equal(s.status, 10, out(s)); assert.match(s.stdout, new RegExp(debtSha)); assert.match(s.stdout, /still owes: heavy \+ predeploy/);

  const d = fx.debts()[0];
  const late = new Date(new Date(d.deadline).getTime() + HOUR);
  const v = verifyDeploy(fx.repo, { now: late });
  assert.equal(v.ok, false); assert.match(v.reason, /OVERDUE/);
  assert.equal(status(fx.repo, { now: late }).state, "overdue");
  assert.equal(verifyDeploy(fx.repo).ok, true, "still on time with the real clock");

  rewriteDeadline(fx, new Date(Date.now() - HOUR).toISOString());
  const r = fx.hook("bash deploy.sh");
  assert.equal(r.status, 2, out(r)); assert.match(r.stderr, /OVERDUE/);
  s = fx.cli("status");
  assert.equal(s.status, 11, out(s)); assert.match(s.stdout, /OVERDUE/);
  const j = fx.cli("status", "--json");
  assert.equal(j.status, 11);
  const js = JSON.parse(j.stdout);
  assert.equal(js.state, "overdue"); assert.equal(js.action.on, debtSha); assert.deepEqual(js.action.run, ["heavy", "predeploy"]);
  assert.equal(js.action.rollbackTo, fx.base); assert.equal(js.debt.overdue, true);
  // overdue blocks even the indebted commit's own further steps, and nothing was rolled back or closed
  assert.equal(fx.debts()[0].closed, null);
});

// ── i. rollback ─────────────────────────────────────────────────────────────
await t("i. rollback to the stamped base is allowed, closes the debt as rolled-back, later steps still pass", () => {
  const fx = mk();
  deployFast(fx, "src/a.ts");
  fx.sh("checkout", "-q", "--detach", fx.base);
  const r = fx.hook("bash deploy.sh");
  assert.equal(r.status, 0, out(r)); assert.match(out(r), /ROLLBACK/);
  const d = fx.debts()[0];
  assert.equal(d.closed.how, "rolled-back"); assert.equal(d.closed.base, fx.base);
  assert.equal(openDebt(fx.repo), null);
  const r2 = fx.hook("bash deploy.sh");
  assert.equal(r2.status, 0, out(r2));
  assert.equal(fx.debts().length, 1);
  assert.equal(readLedger(fx.repo).at(-1).lane, "rollback");
  assert.equal(status(fx.repo).state, "clear");
});

// ── j. permit validity ──────────────────────────────────────────────────────
await t("j. a permit dies with a new commit, with expiry and with any change of the allow/deny rules", () => {
  const fx = mk();
  const sha = fx.change("src/a.ts");
  const p = fx.permit();
  assert.equal(p.ok, true);
  const ok = verifyDeploy(fx.repo);
  assert.equal(ok.ok, true); assert.equal(ok.lane, "fast"); assert.equal(ok.action, "record-debt");

  // expiry
  const exp = new Date(p.permit.expiresAt).getTime();
  assert.equal(verifyDeploy(fx.repo, { now: new Date(exp - 60000) }).ok, true);
  const late = verifyDeploy(fx.repo, { now: new Date(exp + 60000) });
  assert.equal(late.ok, false); assert.match(late.reason, /expired/);
  assert.equal(status(fx.repo, { now: new Date(exp + 60000) }).permit, null);

  // rules: an uncommitted change to the allow list (and the deny list) voids it
  const cfgFile = join(fx.repo, "maple.config.json");
  const orig = readFileSync(cfgFile, "utf8");
  for (const edit of [{ ...FL, allow: [...FL.allow, "scripts/**"] }, { ...FL, deny: ["src/pricing/**"] }]) {
    writeFileSync(cfgFile, JSON.stringify(cfgOf(edit), null, 2));
    const v = verifyDeploy(fx.repo);
    assert.equal(v.ok, false); assert.match(v.reason, /rules changed/);
    fx.sh("checkout", "--", "maple.config.json");
  }
  assert.equal(readFileSync(cfgFile, "utf8").replace(/\r\n/g, "\n"), orig.replace(/\r\n/g, "\n")); // autocrlf may rewrite line endings
  assert.equal(verifyDeploy(fx.repo).ok, true, "restored rules: the permit stands again");

  // a new commit
  fx.commit({ "src/z.ts": "export const z = 1;\n" });
  const v = verifyDeploy(fx.repo);
  assert.equal(v.ok, false); assert.match(v.reason, /no fast-lane permit for HEAD/);
  const r = fx.hook("bash deploy.sh");
  assert.equal(r.status, 2, out(r)); assert.equal(fx.debts().length, 0);
  assert.notEqual(sha, fx.head());
});

await t("j2. the permit is re-proved at deploy time: a tampered or un-stamped base no longer qualifies", () => {
  const fx = mk();
  fx.change("src/a.ts");
  assert.equal(fx.permit().ok, true);
  rmSync(join(fx.repo, ".git", "maple", "heavy-pass", `${fx.base}.json`));
  const v = verifyDeploy(fx.repo);
  assert.equal(v.ok, false); assert.match(v.reason, /no longer proves eligible|no fully stamped/);
});

// ── k. the state is guarded ─────────────────────────────────────────────────
await t("k. tool calls cannot write the lane's state; the sanctioned CLI is not blocked", () => {
  const fx = mk();
  const target = ".git/maple/predeploy/fast-lane/permit.json";
  for (const cmd of [`echo {} > ${target}`, `rm ${target}`, `echo x >> .git/maple/predeploy/fast-lane/debt.jsonl`, `sed -i s/a/b/ .git/maple/predeploy/fast-lane/debt.jsonl`]) {
    const r = fx.hook(cmd);
    assert.equal(r.status, 2, cmd + "\n" + out(r)); assert.match(r.stderr, /gate's state/);
  }
  for (const tool of ["Write", "Edit", "MultiEdit"]) {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: { file_path: join(fx.repo, ".git", "maple", "predeploy", "fast-lane", "permit.json") }, cwd: fx.repo }), encoding: "utf8" });
    assert.equal(r.status, 2, tool + out(r));
  }
  for (const sub of ["status", "permit", "check"]) {
    const r = fx.hook(`node ${CLI_FWD} ${sub}`);
    assert.equal(r.status, 0, sub + "\n" + out(r));
  }
  assert.equal(fx.hook(`cat ${target}`).status, 0, "reading is fine");
});

// ── l. the real secret scan ─────────────────────────────────────────────────
await t(which("gitleaks") ? "l. real gitleaks: a clean diff passes, a diff adding an AWS key is refused by permit (no stub)" : "skip - gitleaks not installed", () => {
  if (!which("gitleaks")) return;
  const clean = mk();
  clean.change("src/a.ts");
  assert.deepEqual(secretScan(clean.repo, clean.base, clean.head()).ok, true, secretScan(clean.repo, clean.base, clean.head()).reason);
  assert.equal(permit(clean.repo).ok, true, "no stub: the real scan passes a clean diff");

  const fx = mk();
  const s = fx.commit({ "src/k.ts": `export const key = "${["AKIA", "J5QWXN3K", "Z7YTR2BD"].join("")}";\nexport const secret = "${["wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCYzP3ShmFpTd"].join("")}";\n` }); // fake pair, assembled at runtime so no literal key sits in this repo
  fx.gatePass(s);
  const p = permit(fx.repo);
  assert.equal(p.ok, false, JSON.stringify(p));
  assert.match(p.failures.join("\n"), /secret finding/);
  assert.ok(!existsSync(permitFile(fx.repo)));
  assert.equal(fx.hook("bash deploy.sh").status, 2);
});

console.log(`\n${n} fast-lane integration tests passed`);
for (const d of dirs) rmSync(d, { recursive: true, force: true });
