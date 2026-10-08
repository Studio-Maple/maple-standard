/**
 * exposure.test.mjs - unit tests for the stack-exposure standard (D072): the build-side preset, its config
 * validation and coverage, and the live probes (fake fetch, no network). Hermetic: temp dirs only.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stackExposure, versionIndex, packageVersions, textRules, nginxFindings, expressFindings } from "./exposure.mjs";
import { exposureCoverage, validateExposure } from "./exposure-config.mjs";
import { liveExposure, probePlan, responseFindings, NOT_FOUND_PROBE } from "./exposure-live.mjs";
import { validatePredeploy } from "./config.mjs";

let n = 0;
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const SHA = "b7a64f4d65d18b6ffcef30ab7d3937bd8a1725bd";
const ids = (fs) => fs.map((f) => f.id).sort();

function fixture(files, tracked = {}) {
  const root = mkdtempSync(join(tmpdir(), "maple-exposure-"));
  for (const [rel, body] of Object.entries({ ...files, ...tracked })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
  const trackedList = Object.keys(tracked);
  const ctx = { root, scanRoot: root, sha: SHA, listFiles: (re) => trackedList.filter((f) => re.test(f)) };
  return { root, ctx, done: () => rmSync(root, { recursive: true, force: true }) };
}
const surface = (extra = {}) => ({ surfaces: [{ name: "app", dir: "dist", build: "true", exclude: ["_worker.js"], ...extra }] });
const LOCK = JSON.stringify({ packages: { "": {}, "node_modules/react-dom": { version: "19.3.0" }, "node_modules/ms": { version: "2.1.3" }, "node_modules/@types/react-dom": { version: "19.3.0" }, "node_modules/@supabase/realtime-js": { version: "2.117.2" } } });

// ── build-side preset ───────────────────────────────────────────────────────
t("a clean, hash-named build passes", async () => {
  const fx = fixture({ "dist/index.html": '<script type="module" src="/assets/Ab12Cd34.js"></script>', "dist/assets/Ab12Cd34.js": 'console.log("hi")', "dist/_worker.js": "/*! license */ VITE_X:1" });
  const r = await stackExposure(surface(), fx.ctx);
  assert.deepEqual(r.findings, []);
  fx.done();
});
t("every bundle rule fires once per rule+key, located at the surface dir", async () => {
  const fx = fixture({
    "dist/assets/dialer-C8Zdmocc.js": `/*! tailwindcss v4.3.3 */ const e={VITE_RELEASE:"${SHA}",BASE_URL:"/",MODE:"production"}; fetch("/dev-harness"); "dash.example.com"`,
    "dist/assets/Ab12Cd34.js": `x={version:"19.3.0",rendererPackageName:"react-dom"};//# sourceMappingURL=Ab12Cd34.js.map`,
    "dist/assets/Ab12Cd34.js.map": "{}", "dist/.env": "X=1", "dist/package.json": "{}",
  }, { "package-lock.json": LOCK });
  const r = await stackExposure({ ...surface(), devRoutes: ["/dev-harness"], forbidden: ["dash.example.com"] }, fx.ctx);
  const got = ids(r.findings);
  for (const id of ["commit-sha", "dev-route", "env-dump", "forbidden-string", "license-banner", "package-version", "readable-asset-name", "sensitive-file", "source-map"]) assert.ok(got.includes(id), `missing ${id}: ${got}`);
  assert.ok(r.findings.every((f) => f.location === "dist"));
  const pv = r.findings.find((f) => f.id === "package-version");
  assert.equal(pv.resource, "react-dom");
  assert.equal(r.findings.filter((f) => f.id === "sensitive-file").length, 2);
  fx.done();
});
t("package versions: scoped basename banner matches, short names do not", () => {
  const idx = versionIndex([{ kind: "npm", text: LOCK }, { kind: "pnpm", text: "packages:\n\n  '@scope/widget@1.4.2':\n    resolution: x\n" }]);
  assert.deepEqual([...packageVersions("realtime-js/2.117.2", idx).keys()], ["@supabase/realtime-js"]);
  assert.deepEqual([...packageVersions('ms="2.1.3"', idx).keys()], []);
  assert.deepEqual([...packageVersions('n="widget",v="1.4.2"', idx).keys()], ["@scope/widget"]);
  assert.deepEqual([...packageVersions('x="19.3.0"', idx).keys()], [], "a bare version with no name nearby is not a finding");
});
t("text rules: individually inlined env values and short hashes are clean", () => {
  assert.deepEqual(textRules('const u="https://x";const r="abc1234";', { shas: [SHA, SHA.slice(0, 12)] }), []);
  assert.equal(textRules("// @license MIT")[0].rule, "license-banner");
  assert.equal(textRules('{"NEXT_PUBLIC_API": "x"}')[0].key, "NEXT_PUBLIC_API");
});
t("login graph over budget and app markers reachable from the login page fail", async () => {
  const fx = fixture({
    "dist/login/index.html": '<link rel="modulepreload" href="/assets/Aa11Bb22.js"><script src="./Cc33Dd44.js"></script>',
    "dist/login/Cc33Dd44.js": "x", "dist/assets/Aa11Bb22.js": 'import("./Ee55Ff66.js")', "dist/assets/Ee55Ff66.js": "softphoneRegister()",
  });
  const r = await stackExposure({ ...surface({ loginEntry: "login/index.html", loginBudget: { maxFiles: 3 } }), appMarkers: ["softphoneRegister"] }, fx.ctx);
  assert.deepEqual(ids(r.findings), ["login-graph-files", "login-graph-marker"]);
  fx.done();
});
t("a failed build and a missing dir are findings, never a pass", async () => {
  const fx = fixture({});
  assert.deepEqual(ids((await stackExposure({ surfaces: [{ name: "a", dir: "dist", build: "exit 3" }] }, fx.ctx)).findings), ["build-failed"]);
  assert.deepEqual(ids((await stackExposure(surface(), fx.ctx)).findings), ["surface-missing"]);
  fx.done();
});
t("nginx server blocks need server_tokens off; express needs x-powered-by disabled", async () => {
  assert.equal(nginxFindings([{ path: "deploy/a.conf", text: "server {\n  listen 80;\n}" }]).length, 1);
  assert.equal(nginxFindings([{ path: "deploy/a.conf", text: "http { server_tokens off; }\nserver {\n listen 80;\n}" }]).length, 0);
  const pkgs = [{ path: "svc/package.json", json: { dependencies: { express: "^5" } } }];
  assert.equal(expressFindings(pkgs, () => ["const app = express();"]).length, 1);
  assert.equal(expressFindings(pkgs, () => ['app.disable("x-powered-by")']).length, 0);
  const fx = fixture({}, { "infra/provision.sh.tftpl": "cat <<EOF\nserver {\n  listen 127.0.0.1:8081;\n}\nEOF\n" });
  assert.deepEqual(ids((await stackExposure({ surfaces: [] }, fx.ctx)).findings), ["nginx-server-tokens"]);
  fx.done();
});

// ── config + coverage ───────────────────────────────────────────────────────
const base = (extra = {}) => ({ predeploy: { checks: [{ id: "exposure", preset: "stack-exposure", options: surface() }], ...extra } });
t("a valid stack-exposure config validates", () => assert.deepEqual(validatePredeploy(base()), []));
t("bad surfaces are rejected: no build, absolute dir, swallowed failure, hashOnly off", () => {
  const bad = { predeploy: { checks: [{ id: "x", preset: "stack-exposure", options: { surfaces: [{ name: "a", dir: "/abs" }, { name: "b", dir: "d", build: "vite build || true", hashOnly: false }] } }] } };
  const e = validatePredeploy(bad).join("\n");
  for (const s of ["surfaces[0].dir", "surfaces[0].build", "surfaces[1].build: swallows", "surfaces[1].hashOnly"]) assert.ok(e.includes(s), `expected ${s} in\n${e}`);
  assert.ok(validatePredeploy({ predeploy: { checks: [{ id: "x", preset: "stack-exposure" }] } }).some((m) => m.includes("options")));
});
t("opt-out needs a decision id and a reason; live + opt-out together is an error", () => {
  const e = validateExposure({ exposure: { optOut: { bundle: { decision: "nope", why: "short" } }, live: {} } }).join("\n");
  assert.ok(e.includes("optOut.bundle.decision") && e.includes("optOut.bundle.why"));
  assert.ok(validateExposure({ exposure: { optOut: { live: { decision: "D1", why: "x".repeat(25) } }, live: {} } }).some((m) => m.includes("pick one")));
});
t("coverage: unconfigured blocks; opt-out must name a ledger decision; conflict is an error", () => {
  const ledger = { ids: new Set(["D9"]), error: null };
  assert.deepEqual(ids(exposureCoverage({ checks: [] }, ledger)), ["exposure-unconfigured"]);
  assert.deepEqual(exposureCoverage({ checks: [{ preset: "stack-exposure" }] }, ledger), []);
  const oo = (d) => ({ checks: [], exposure: { optOut: { bundle: { decision: d, why: "a pure JSON API with no web build" } } } });
  assert.deepEqual(exposureCoverage(oo("D9"), ledger), []);
  assert.deepEqual(ids(exposureCoverage(oo("D10"), ledger)), ["exposure-optout-decision-missing"]);
  assert.deepEqual(ids(exposureCoverage({ ...oo("D9"), checks: [{ preset: "stack-exposure" }] }, ledger)), ["exposure-optout-conflict"]);
});

// ── live probes ─────────────────────────────────────────────────────────────
t("response rules: versioned Server, X-Powered-By, version headers, banners, stack traces, framework errors", () => {
  const f = responseFindings({ url: "u", headers: { server: "nginx/1.24.0", "x-powered-by": "Express", "x-generator": "Next", via: "1.1 varnish/6.0" }, body: "<center>nginx/1.24.0 (Ubuntu)</center>\n    at handler (/srv/app/index.js:10:5)\nCannot GET /x" });
  assert.deepEqual(ids(f), ["exposure:framework-error", "exposure:server-banner", "exposure:server-version", "exposure:stack-trace", "exposure:version-header", "exposure:via-version", "exposure:x-powered-by"]);
  assert.deepEqual(responseFindings({ url: "u", headers: { server: "cloudflare" }, body: '{"error":"internal_error"}' }), []);
  assert.equal(responseFindings({ url: "u", headers: { "x-release": "1" }, body: "", sha: SHA }).length, 1);
  assert.equal(responseFindings({ url: "u", headers: { etag: SHA }, body: "", sha: SHA })[0].id, "exposure:version-header");
});
t("probe plan: target + not-found path; call-origination paths are refused", () => {
  const ls = { targets: [{ id: "app", url: "https://app.example.com/login" }], callOriginationExcludes: ["^/api/calls"] };
  const { plan, refused } = probePlan(ls, { probes: [{ path: "/api/calls/start", method: "POST" }, { path: "/api/x", method: "POST" }] });
  assert.deepEqual(plan.map((p) => p.url), ["https://app.example.com/login", "https://app.example.com" + NOT_FOUND_PROBE, "https://app.example.com/api/x"]);
  assert.equal(refused.length, 1);
});

function fakeFetch(routes) {
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url, init });
    const r = routes[new URL(url).pathname];
    if (!r) return new Response("not found", { status: 404, headers: { "content-type": "text/plain", server: "cloudflare" } });
    return new Response(r.body, { status: r.status || 200, headers: { "content-type": r.ct || "text/html", ...(r.headers || {}) } });
  };
  fn.seen = seen;
  return fn;
}
t("liveExposure: anonymous probes, login crawl budget/code/text rules, never sends auth headers", async () => {
  const fetchImpl = fakeFetch({
    "/login": { body: '<script type="module" src="/assets/a.js"></script>' },
    "/assets/a.js": { ct: "text/javascript", body: 'import("./b.js");/*! x */' },
    "/assets/b.js": { ct: "text/javascript", body: "dialerStore" },
  });
  const ls = { targets: [{ id: "app", url: "https://app.example.com/login", headers: [{ name: "Authorization", credentialRef: "Scan-Token" }] }] };
  const pd = { exposure: { live: { loginGraph: { target: "app", path: "/login", maxFiles: 2, allowCode: false, markers: ["dialerStore"] } } } };
  const r = await liveExposure(pd, ls, { sha: SHA, fetchImpl });
  assert.deepEqual(ids(r.findings), ["exposure:login-graph-code", "exposure:login-graph-files", "exposure:login-graph-marker", "exposure:login-license-banner"]);
  assert.ok(fetchImpl.seen.every((s) => !s.init.headers || !("Authorization" in s.init.headers)));
  assert.ok(fetchImpl.seen.every((s) => ["GET", "HEAD", "OPTIONS", "POST"].includes(s.init.method)));
});
t("liveExposure: an unanswered probe is a finding; opt-out needs the decision in the ledger", async () => {
  const ls = { targets: [{ id: "app", url: "https://app.example.com/" }] };
  const r = await liveExposure({}, ls, { fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  assert.ok(r.findings.every((f) => f.id === "exposure:probe-failed") && r.findings.length === 2);
  const pd = { exposure: { optOut: { live: { decision: "D4", why: "x".repeat(30) } } } };
  assert.deepEqual((await liveExposure(pd, ls, { ledger: { ids: new Set(["D4"]), error: null }, fetchImpl: null })).findings, []);
  assert.equal((await liveExposure(pd, ls, { ledger: { ids: new Set(), error: null } })).findings[0].id, "exposure-optout-decision-missing");
});

for (const [name, fn] of tests) { await fn(); n++; console.log("ok - " + name); }
console.log(`exposure: ${n} tests passed`);
