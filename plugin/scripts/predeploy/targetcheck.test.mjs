// Live-scan target reachability preflight: fixture responses (Cloudflare 530/522 error pages, Access wall,
// healthy app, connection failures), schedule notes, config validation, and the blocking "target down" record.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePredeploy } from "./config.mjs";
import { recordTargetDown } from "./livescan.mjs";
import { liveScanDebt } from "./state.mjs";
import { checkTargets, classifyResponse, probeTarget, scheduleNote, scheduleState } from "./targetcheck.mjs";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

// Fixtures: what the edge actually answers when a parked target is behind Cloudflare.
const CF_530 = { status: 530, headers: { server: "cloudflare", "cf-ray": "9a1b2c3d4e5f-FRA" }, body: "<!DOCTYPE html><title>Cloudflare Tunnel error | credentials.easy-call.co.il | Cloudflare</title><span>Error 1033</span> error code: 1033" };
const CF_522 = { status: 522, headers: { server: "cloudflare", "cf-ray": "9a1b2c3d4e5f-FRA" }, body: "<title>sip.easy-call.co.il | 522: Connection timed out</title><span class=\"cf-error-code\">522</span>" };
const CF_502 = { status: 502, headers: { server: "cloudflare" }, body: "<html><head><title>502 Bad Gateway</title></head><body>cf-error-details Cloudflare</body></html>" };
const ACCESS = { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/app.example?kid=abc&redirect_url=%2F" }, body: "" };
const APP_200 = { status: 200, headers: { server: "cloudflare", "cf-ray": "x" }, body: "<html>app</html>" };
const APP_404 = { status: 404, headers: { server: "cloudflare" }, body: "not found" };
const ORIGIN_502 = { status: 502, headers: { server: "nginx" }, body: "<html>502 Bad Gateway nginx</html>" };
const ORIGIN_503_JSON = { status: 503, headers: { "content-type": "application/json" }, body: "{\"error\":\"maintenance\"}" };

await t("Cloudflare 530 tunnel-down page is down", () => {
  const c = classifyResponse(CF_530);
  assert.equal(c.state, "down"); assert.equal(c.kind, "edge-530"); assert.match(c.reason, /530.*tunnel/); assert.match(c.reason, /1033/);
});
await t("Cloudflare 522 origin timeout is down", () => { const c = classifyResponse(CF_522); assert.equal(c.state, "down"); assert.match(c.reason, /522.*origin timeout/); });
await t("every Cloudflare 52x is down even with no body", () => {
  for (const s of [520, 521, 522, 523, 524, 525, 526, 527, 530]) assert.equal(classifyResponse({ status: s, headers: {}, body: "" }).state, "down", String(s));
});
await t("a Cloudflare-rendered 502 page is down; the app's own 502/503 is not mistaken for an edge page", () => {
  assert.equal(classifyResponse(CF_502).state, "down");
  assert.equal(classifyResponse(ORIGIN_502).state, "up");
  assert.equal(classifyResponse(ORIGIN_503_JSON).state, "up");
});
await t("connection failures are down", () => {
  for (const error of ["ECONNREFUSED connect ECONNREFUSED 10.0.0.1:443", "ENOTFOUND getaddrinfo ENOTFOUND x", "timeout after 15000ms"]) { const c = classifyResponse({ error }); assert.equal(c.state, "down"); assert.equal(c.kind, "connection-failed"); }
});
await t("Access-only answer is a wall for an unauthenticated target, up for an authenticated one", () => {
  assert.equal(classifyResponse(ACCESS).state, "access-wall");
  assert.equal(classifyResponse(ACCESS, { authenticated: true }).state, "up", "the container preflight owns the authenticated case");
  assert.equal(classifyResponse({ status: 403, headers: {}, body: "<title>Cloudflare Access</title> Forbidden" }).state, "access-wall");
});
await t("healthy responses are up (incl. 404 and a plain 403 from the app)", () => {
  for (const r of [APP_200, APP_404, { status: 403, headers: { server: "nginx" }, body: "forbidden" }, { status: 301, headers: { location: "https://example.com/" }, body: "" }]) assert.equal(classifyResponse(r).state, "up");
});

const sched = { days: ["sun", "mon", "tue", "wed", "thu"], from: "06:45", to: "21:00", tz: "Asia/Jerusalem" };
await t("schedule window: inside, before opening, after closing, weekend", () => {
  assert.equal(scheduleState(sched, new Date("2026-10-11T09:00:00Z")).inside, true);  // Sun 12:00 IL
  assert.equal(scheduleState(sched, new Date("2026-10-11T03:00:00Z")).inside, false); // Sun 06:00 IL
  assert.equal(scheduleState(sched, new Date("2026-10-08T19:00:00Z")).inside, false); // Thu 22:00 IL
  assert.equal(scheduleState(sched, new Date("2026-10-09T09:00:00Z")).inside, false); // Fri
  assert.equal(scheduleState(undefined), null);
  assert.equal(scheduleState({ from: "00:00", to: "24:00", tz: "Not/AZone" }), null);
});
await t("schedule note wording", () => {
  assert.match(scheduleNote(sched, new Date("2026-10-08T19:00:00Z")), /outside its declared schedule.*sun,mon,tue,wed,thu 06:45-21:00 Asia\/Jerusalem.*parked on purpose/);
  assert.match(scheduleNote(sched, new Date("2026-10-11T09:00:00Z")), /unexpected outage/);
  assert.equal(scheduleNote(undefined), "");
});

const fixtureProbe = (map) => async (url) => map[url];
await t("checkTargets: the 2026-10-08 incident (two parked targets) blocks with target-down, never header findings", async () => {
  const ls = { schedule: sched, targets: [
    { id: "credentials", url: "https://credentials.easy-call.co.il/", headers: [{ name: "X", credentialRef: "r" }] },
    { id: "sip", url: "https://sip.easy-call.co.il:8443/" },
    { id: "app", url: "https://app.easy-call.co.il/" },
  ] };
  const r = await checkTargets(ls, { now: new Date("2026-10-08T19:30:00Z"), probe: fixtureProbe({ "https://credentials.easy-call.co.il/": CF_530, "https://sip.easy-call.co.il:8443/": CF_522, "https://app.easy-call.co.il/": APP_200 }) });
  assert.deepEqual(r.findings.map((f) => f.id), ["target-down:credentials", "target-down:sip"]);
  for (const f of r.findings) { assert.equal(f.severity, "high"); assert.equal(f.check, "live-scan"); assert.match(f.message, /scan not meaningful/); assert.match(f.message, /outside its declared schedule/); assert.match(f.message, /No ZAP scan was run/); }
  assert.equal(r.results.find((x) => x.id === "app").state, "up");
});
await t("checkTargets: all up -> no findings; no schedule -> no schedule note; per-target schedule overrides", async () => {
  const up = await checkTargets({ targets: [{ id: "a", url: "https://a/" }] }, { probe: fixtureProbe({ "https://a/": APP_200 }) });
  assert.deepEqual(up.findings, []);
  const down = await checkTargets({ schedule: sched, targets: [{ id: "a", url: "https://a/", schedule: { from: "00:00", to: "24:00", tz: "UTC" } }, { id: "b", url: "https://b/" }] }, { now: new Date("2026-10-08T19:00:00Z"), probe: fixtureProbe({ "https://a/": CF_530, "https://b/": CF_530 }) });
  assert.match(down.findings[0].message, /unexpected outage/);
  assert.match(down.findings[1].message, /parked on purpose/);
  const bare = await checkTargets({ targets: [{ id: "a", url: "https://a/" }] }, { probe: fixtureProbe({ "https://a/": CF_530 }) });
  assert.doesNotMatch(bare.findings[0].message, /schedule/);
});
await t("checkTargets: Access-only wall on an unauthenticated target blocks; a transient error is retried once", async () => {
  const w = await checkTargets({ targets: [{ id: "a", url: "https://a/" }] }, { probe: fixtureProbe({ "https://a/": ACCESS }) });
  assert.match(w.findings[0].message, /behind Cloudflare Access only/);
  let calls = 0;
  const flaky = async () => (++calls === 1 ? { error: "ECONNRESET" } : APP_200);
  assert.deepEqual((await checkTargets({ targets: [{ id: "a", url: "https://a/" }] }, { probe: flaky })).findings, []);
  assert.equal(calls, 2);
});

await t("probeTarget against a real local server: 200, a Cloudflare-style 530, Access redirect, closed port", async () => {
  const srv = createServer((req, res) => {
    if (req.url === "/530") { res.writeHead(530, { server: "cloudflare" }); res.end("error code: 1033"); }
    else if (req.url === "/access") { res.writeHead(302, { location: "https://x.cloudflareaccess.com/login" }); res.end(); }
    else { res.writeHead(200); res.end("ok"); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal(classifyResponse(await probeTarget(base + "/")).state, "up");
    assert.equal(classifyResponse(await probeTarget(base + "/530")).state, "down");
    assert.equal(classifyResponse(await probeTarget(base + "/access")).state, "access-wall", "redirects are not followed");
  } finally { await new Promise((r) => srv.close(r)); }
  const dead = await probeTarget(base + "/", { timeoutMs: 3000 });
  assert.ok(dead.error, "server closed -> connection error");
  assert.equal(classifyResponse(dead).state, "down");
});

await t("config: schedule validated on liveScan and on targets", () => {
  const errs = (c) => validatePredeploy(c).filter((m) => !/predeploy.checks/.test(m));
  const base = (extra, tExtra) => ({ predeploy: { liveScan: { ...extra, callOriginationExcludes: [], noCallOriginationRoutes: true, guards: { noRealCustomerCredentials: true, noPstnCalls: true }, targets: [{ id: "a", url: "https://a/", ...tExtra }] } } });
  assert.deepEqual(errs(base({ schedule: sched }, { schedule: sched })), []);
  assert.ok(errs(base({ schedule: { from: "6:45", to: "21:00" } })).some((m) => /schedule\.from/.test(m)));
  assert.ok(errs(base({}, { schedule: { days: ["funday"], from: "06:00", to: "07:00" } })).some((m) => /schedule\.days/.test(m)));
  assert.ok(errs(base({}, { schedule: { from: "06:00", to: "07:00", tz: "Mars/Base" } })).some((m) => /schedule\.tz/.test(m)));
  assert.ok(errs(base({}, { schedule: "nights" })).some((m) => /schedule/.test(m)));
});

await t("target-down record: status fail, outcome target-down, debt reason says the target was down", () => {
  const root = mkdtempSync(join(tmpdir(), "targetcheck-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, "maple.config.json"), "{}");
    const findings = [{ check: "live-scan", id: "target-down:sip", severity: "high", message: "target sip is down - scan not meaningful (x)", location: "https://sip/" }];
    const logs = []; const origErr = console.error; console.error = (m) => logs.push(m);
    let code; try { code = recordTargetDown({ args: {}, root, sha: "abc", coversSeq: 0, ls: { targets: [{ id: "sip", url: "https://sip/" }] }, findings }); } finally { console.error = origErr; }
    assert.equal(code, 1);
    assert.match(logs.join("\n"), /TARGET DOWN, SCAN NOT MEANINGFUL/);
    assert.match(logs.join("\n"), /not a pass and not an app finding/);
    const files = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
    walk(root);
    const rec = JSON.parse(readFileSync(files.find((p) => /live-scans[\\/][^\\/]+\.json$/.test(p)), "utf8"));
    assert.equal(rec.status, "fail"); assert.equal(rec.outcome, "target-down"); assert.equal(rec.findings[0].id, "target-down:sip");
    const debt = liveScanDebt(root, { liveScan: { requireAfterDeploy: true, targets: [] } });
    assert.equal(debt.ok, false); assert.match(debt.reason, /target was down \(scan not meaningful\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

console.log(`\n${n} targetcheck tests passed`);
