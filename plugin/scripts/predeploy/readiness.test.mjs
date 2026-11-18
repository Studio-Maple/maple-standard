// readiness: a target with a readyPath is scanned only after that path answers HTTP 200 for a stable stretch.
import assert from "node:assert/strict";
import { waitForReady } from "./readiness.mjs";
import { validatePredeploy } from "./config.mjs";
import { parseOutput } from "./parsers.mjs";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

// A fake clock: sleep advances it, probes read a script of answers.
const rig = (answers) => {
  let clock = 0; let i = 0; const calls = [];
  return {
    calls, clock: () => clock,
    opts: { now: () => clock, sleep: async (ms) => { clock += ms; }, probe: async (url, headers) => { calls.push({ url, headers }); const a = answers[Math.min(i++, answers.length - 1)]; return typeof a === "function" ? a(clock) : a; }, stableMs: 30000, timeoutMs: 120000, intervalMs: 5000 },
  };
};
const ls = (extra = {}) => ({ targets: [{ id: "cp", url: "https://c.example.com/app/", readyPath: "/readyz", ...extra }, { id: "web", url: "https://w.example.com/" }] });

await t("no readyPath = no wait and no probe (today's behaviour)", async () => {
  const r = rig([{ status: 500 }]);
  const out = await waitForReady({ targets: [{ id: "web", url: "https://w.example.com/" }] }, r.opts);
  assert.equal(out.findings.length, 0); assert.equal(r.calls.length, 0);
});
await t("200 for the stable stretch passes; the probe hits origin+readyPath with the scan's headers", async () => {
  const r = rig([{ status: 200 }]);
  const out = await waitForReady(ls(), { ...r.opts, headersFor: (tg) => (tg.id === "cp" ? { "CF-Access-Client-Id": "x" } : {}) });
  assert.equal(out.findings.length, 0); assert.equal(out.results.length, 1);
  assert.equal(r.calls[0].url, "https://c.example.com/readyz"); assert.deepEqual(r.calls[0].headers, { "CF-Access-Client-Id": "x" });
});
await t("a booting origin (52x, then 200) waits, and one dip resets the streak", async () => {
  const r = rig([{ status: 522 }, { status: 522 }, { status: 200 }, { status: 200 }, { error: "ECONNRESET" }, { status: 200 }]);
  const out = await waitForReady(ls(), r.opts);
  assert.equal(out.findings.length, 0);
  assert.ok(r.clock() >= 30000 + 5 * 5000, "the dip must restart the 30 s stable window, got " + r.clock());
});
await t("never ready within the timeout: blocking target-not-ready, never a pass", async () => {
  const r = rig([{ status: 503 }]);
  const out = await waitForReady(ls(), r.opts);
  assert.equal(out.findings.length, 1);
  const f = out.findings[0];
  assert.equal(f.id, "target-not-ready:cp"); assert.equal(f.severity, "high"); assert.match(f.message, /HTTP 503/);
});
await t("flapping 200/500 never reaches the stable window", async () => {
  let k = 0;
  const r = rig([() => ({ status: k++ % 2 ? 500 : 200 })]);
  const out = await waitForReady(ls(), r.opts);
  assert.equal(out.findings.length, 1);
});

await t("config: readyPath is an optional path, nothing else", () => {
  const base = (extra) => ({ predeploy: { liveScan: { enabled: true, callOriginationExcludes: ["^/x"], guards: { noRealCustomerCredentials: true, noPstnCalls: true }, targets: [{ id: "cp", url: "https://c.example.com/", ...extra }] }, checks: [] } });
  const msgs = (c) => validatePredeploy(c).filter((m) => /readyPath/.test(m));
  assert.equal(msgs(base({ readyPath: "/readyz" })).length, 0);
  assert.equal(msgs(base({})).length, 0);
  assert.equal(msgs(base({ readyPath: "https://evil.example/readyz" })).length, 1);
  assert.equal(msgs(base({ readyPath: "/r?x=1" })).length, 1);
  assert.equal(msgs(base({ readyPath: "readyz" })).length, 1);
});

await t("zap findings carry the de-duplicated instance URLs (capped), the location stays the first", () => {
  const inst = [...Array(60).keys()].map((i) => ({ uri: `https://x/p${i % 55}` }));
  const rep = JSON.stringify({ site: [{ "@name": "https://x", alerts: [{ pluginid: "10035", name: "HSTS", riskcode: "1", instances: inst }] }] });
  const f = parseOutput("zap-json", { reports: ["x"], readReport: () => rep })[0];
  assert.equal(f.location, "https://x/p0"); assert.equal(f.uris.length, 50); assert.equal(new Set(f.uris).size, 50);
});

console.log(`\n${n} readiness tests passed`);
