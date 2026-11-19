#!/usr/bin/env node
// Tests for the add-time package checks (D079-D081): parsing, resolution under the cooldown, OSV, reputation,
// typosquat, cache, failure handling. Every network call goes through an injected fetchImpl.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAdds } from "./add-cmd.mjs";
import { checkAdds } from "./add-guard.mjs";
import { distance, typosquatOf } from "./edit-distance.mjs";
import { checkPackageAdds } from "./package-add.mjs";

delete process.env.npm_config_registry;
delete process.env.NPM_CONFIG_REGISTRY;

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed++;
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-19T12:00:00Z");
const ago = (d) => new Date(NOW - d * DAY).toISOString();
const dirs = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

// A fixture popular-names directory so the typosquat tests do not depend on the generated lists.
const top = tmp("top-");
writeFileSync(join(top, "top-npm.json"), JSON.stringify({ names: ["express", "left-pad", "lodash", "react"] }));
writeFileSync(join(top, "top-pypi.json"), JSON.stringify({ names: ["numpy", "requests"] }));

/** npm packument: latest published `latestAge` days ago, 1.0.0 `oldAge` days ago, package created `createdAge` days ago. */
const npmDoc = ({ latest = "1.1.0", latestAge = 100, oldAge = 200, createdAge = 400, deprecated } = {}) => ({
  "dist-tags": { latest },
  versions: { "1.0.0": {}, [latest]: deprecated ? { deprecated } : {} },
  time: { created: ago(createdAge), modified: ago(1), "1.0.0": ago(oldAge), [latest]: ago(latestAge) },
});
const pypiDoc = ({ latest = "2.0.0", latestAge = 100, oldAge = 300 } = {}) => ({
  info: { version: latest, classifiers: [] },
  releases: { "1.0.0": [{ upload_time_iso_8601: ago(oldAge) }], [latest]: [{ upload_time_iso_8601: ago(latestAge) }] },
});

/** URL-routed fake network. `npm`/`pypi` map name -> document, `downloads` name -> weekly, `osv` "name@version" -> ids. */
function fakeNet({ npm = {}, pypi = {}, downloads = {}, osv = {}, down = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if (down) throw new Error("getaddrinfo ENOTFOUND");
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    const nf = () => ({ ok: false, status: 404, json: async () => ({}) });
    let m;
    if (url === "https://api.osv.dev/v1/querybatch") {
      const q = JSON.parse(init.body).queries;
      return ok({ results: q.map((x) => ({ vulns: (osv[`${x.package.name}@${x.version}`] ?? []).map((id) => ({ id })) })) });
    }
    if ((m = /^https:\/\/registry\.npmjs\.org\/(.+)$/.exec(url))) return npm[decodeURIComponent(m[1])] ? ok(npm[decodeURIComponent(m[1])]) : nf();
    if ((m = /^https:\/\/api\.npmjs\.org\/downloads\/point\/last-week\/(.+)$/.exec(url))) return ok({ downloads: downloads[m[1]] ?? 5_000_000 });
    if ((m = /^https:\/\/pypi\.org\/pypi\/(.+)\/json$/.exec(url))) return pypi[m[1]] ? ok(pypi[m[1]]) : nf();
    if ((m = /^https:\/\/pypistats\.org\/api\/packages\/(.+)\/recent$/.exec(url))) return ok({ data: { last_week: downloads[m[1]] ?? 5_000_000 } });
    throw new Error(`unexpected url ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const run = async (command, root, net, extra = {}) => {
  const cacheDir = extra.cacheDir ?? tmp("cache-");
  return checkAdds(command, root, { fetchImpl: net, now: NOW, cacheDir, topDir: top, necessity: false, ...extra });
};
const rules = (r) => r.packageAdd.rules;

try {
  console.log("add-cmd parsing");
  const sum = (c) => parseAdds(c).map((a) => `${a.eco}:${a.name}${a.spec ? `@${a.spec}` : ""}${a.dev ? ":dev" : ""}${a.global ? ":g" : ""}`);
  eq("bare + range + dist-tag npm names are all adds", sum("pnpm add react zod@^3 foo@latest"), ["npm:react", "npm:zod@^3", "npm:foo@latest"]);
  eq("bare pnpm install adds nothing", sum("pnpm install"), []);
  eq("npm -D / -g flags", sum("npm i -D vitest && npm i -g @s/x@1.2.3"), ["npm:vitest:dev", "npm:@s/x@1.2.3:g"]);
  eq("bun add -d is dev", sum("bun add -d vitest"), ["npm:vitest:dev"]);
  eq("pip install ignores -r and flags", sum('pip install -U requests==2.31.0 "httpx>=0.2" -r req.txt'), ["PyPI:requests@==2.31.0", "PyPI:httpx@>=0.2"]);
  eq("python -m pip install", sum("python -m pip install Flask_Login"), ["PyPI:flask-login"]);
  eq("uv pip install with extras", sum("uv pip install flask[async]~=3.0"), ["PyPI:flask@~=3.0"]);
  eq("uv add --group dev", sum("uv add --group dev pytest"), ["PyPI:pytest:dev"]);
  eq("uv add --dev", sum("uv add --dev ruff"), ["PyPI:ruff:dev"]);
  eq("poetry add -G dev / plain", sum("poetry add -G dev black && poetry add httpx"), ["PyPI:black:dev", "PyPI:httpx"]);
  eq("requirements file only adds nothing", sum("pip install -r requirements.txt"), []);
  eq("paths and urls are not adds", sum("pip install . ./pkg.whl git+https://x/y.git"), []);
  eq("npm alias resolves to its target", sum("pnpm add foo@npm:bar@2.0.0"), ["npm:bar@2.0.0"]);

  console.log("edit distance / typosquat");
  eq("transposition is distance 1", distance("lodahs", "lodash"), 1);
  eq("insertion", distance("expresss", "express"), 1);
  eq("far names exceed the cap", distance("abcdef", "uvwxyz") > 2, true);
  eq("lodahs squats lodash", typosquatOf("lodahs", "npm", top)[0]?.name, "lodash");
  eq("expresss squats express", typosquatOf("expresss", "npm", top)[0]?.name, "express");
  eq("reqeusts squats requests", typosquatOf("reqeusts", "PyPI", top)[0]?.name, "requests");
  eq("the popular name itself is not a squat", typosquatOf("lodash", "npm", top), []);
  eq("unrelated name is clean", typosquatOf("totally-different-thing", "npm", top), []);

  console.log("bare-name lookup, OSV, release age");
  const root = tmp("proj-");
  let net = fakeNet({ npm: { "tiny-lib": npmDoc() } });
  let r = await run("pnpm add tiny-lib", root, net);
  check("bare name IS looked up (registry + downloads + OSV)", net.calls.length === 3 && r.packageAdd.deny === null, net.calls.join(" "));
  eq("clean package: no findings, no warnings", [r.packageAdd.deny, r.packageAdd.warnings], [null, []]);

  net = fakeNet({ npm: { "tiny-lib": npmDoc() }, osv: { "tiny-lib@1.1.0": ["GHSA-aaaa-bbbb-cccc", "CVE-2026-0001"] } });
  r = await run("pnpm add tiny-lib", root, net);
  check("OSV hit -> osv finding listing the ids", rules(r).includes("osv") && r.packageAdd.deny.includes("GHSA-aaaa-bbbb-cccc") && r.packageAdd.deny.includes("CVE-2026-0001"), r.packageAdd.deny ?? "");
  eq("one batched OSV POST for several packages", await (async () => {
    const n = fakeNet({ npm: { a1: npmDoc(), b1: npmDoc() } });
    await run("pnpm add a1 b1", root, n);
    return n.calls.filter((u) => u.includes("osv.dev")).length;
  })(), 1);

  net = fakeNet({ npm: { "tiny-lib": npmDoc({ latestAge: 2 }) } });
  r = await run("pnpm add tiny-lib", root, net);
  check("young release (2 days) -> release-age finding naming the safe version", rules(r).includes("release-age") && r.packageAdd.deny.includes("tiny-lib@1.0.0") && r.packageAdd.deny.includes("D079"), r.packageAdd.deny ?? "");
  r = await run("pnpm add tiny-lib@1.1.0", root, net);
  check("exact pin of a young release is flagged too", rules(r).includes("release-age"));
  r = await run("pnpm add tiny-lib@^1", root, net);
  check("a range is resolved to the safe version, not age-flagged", !rules(r).includes("release-age"));
  const cool = tmp("proj-cool-");
  writeFileSync(join(cool, ".npmrc"), "min-release-age=7\n");
  r = await run("pnpm add tiny-lib", cool, net);
  check("project cooldown already resolves the bare name to the safe version", !rules(r).includes("release-age"), r.packageAdd.deny ?? "");
  r = await run("pnpm add tiny-lib", root, net, { options: { minReleaseAgeDays: 1 } });
  check("minReleaseAgeDays override (1 day) accepts a 2-day-old release", !rules(r).includes("release-age"));

  const major = { "dist-tags": { latest: "2.0.0" }, versions: { "1.0.0": {}, "2.0.0": {} }, time: { created: ago(400), "1.0.0": ago(200), "2.0.0": ago(2) } };
  r = await run("pnpm add big-lib", root, fakeNet({ npm: { "big-lib": major } }));
  check("safe version is an older MAJOR than the project cooldown allows: no exact-pin suggestion (it would loop with D064)", rules(r).includes("release-age") && !r.packageAdd.deny.includes("big-lib@1.0.0") && r.packageAdd.deny.includes("minimumReleaseAge") && r.packageAdd.deny.includes("D064"), r.packageAdd.deny ?? "");
  net = fakeNet({ npm: { JSONStream: npmDoc() } });
  r = await run("pnpm add JSONStream", root, net);
  check("mixed-case legacy names keep their spelling on the wire (no false not-found)", !rules(r).includes("not-found") && net.calls.some((u) => u.endsWith("/JSONStream")), net.calls.join(" "));

  console.log("reputation (new names only)");
  r = await run("pnpm add tiny-lib", root, fakeNet({ npm: { "tiny-lib": npmDoc() }, downloads: { "tiny-lib": 120 } }));
  check("low weekly downloads", rules(r).includes("downloads") && r.packageAdd.deny.includes("120"), r.packageAdd.deny ?? "");
  r = await run("pnpm add tiny-lib", root, fakeNet({ npm: { "tiny-lib": npmDoc({ createdAge: 5 }) } }));
  check("first published 5 days ago", rules(r).includes("package-age"));
  r = await run("pnpm add tiny-lib", root, fakeNet({ npm: { "tiny-lib": npmDoc({ deprecated: "use other-lib instead" }) } }));
  check("deprecated resolved version", rules(r).includes("deprecated") && r.packageAdd.deny.includes("other-lib"));
  r = await run("pnpm add lodahs", root, fakeNet({ npm: { lodahs: npmDoc() } }));
  check("typosquat lodahs", rules(r).includes("typosquat") && r.packageAdd.deny.includes("lodash"));
  r = await run("pnpm add expresss", root, fakeNet({ npm: { expresss: npmDoc() } }));
  check("typosquat expresss", rules(r).includes("typosquat"));
  r = await run("pnpm add left-pad", root, fakeNet({ npm: { "left-pad": npmDoc() } }));
  check("a popular name itself is clean", !rules(r).includes("typosquat"));
  r = await run("pnpm add ghost-pkg", root, fakeNet({ npm: {} }));
  check("unknown package -> not-found finding", rules(r).includes("not-found"));
  r = await run("pnpm add @acme/private", root, fakeNet({ npm: {} }));
  check("a scoped 404 on the default registry is also flagged", rules(r).includes("not-found"));
  const scoped = tmp("proj-scoped-");
  writeFileSync(join(scoped, ".npmrc"), "@acme:registry=https://npm.acme.test/\n");
  r = await run("pnpm add @acme/private", scoped, fakeNet({ npm: {} }));
  check("... unless .npmrc maps the scope to another registry", !rules(r).includes("not-found") && r.packageAdd.warnings.length === 0);

  const existing = tmp("proj-existing-");
  writeFileSync(join(existing, "package.json"), JSON.stringify({ dependencies: { lodahs: "^1.0.0" } }));
  net = fakeNet({ npm: { lodahs: npmDoc({ createdAge: 3 }) }, downloads: { lodahs: 2 } });
  r = await run("pnpm add lodahs@1.1.0", existing, net);
  check("a name already in a manifest skips reputation (no downloads call, no typosquat)", r.packageAdd.deny === null && !net.calls.some((u) => u.includes("api.npmjs.org")), r.packageAdd.deny ?? "");
  const pyproj = tmp("proj-py-");
  writeFileSync(join(pyproj, "pyproject.toml"), '[project]\nname="x"\ndependencies = ["reqeusts>=1"]\n');
  r = await run("pip install reqeusts", pyproj, fakeNet({ pypi: { reqeusts: pypiDoc() }, downloads: { reqeusts: 3 } }));
  check("same for pyproject.toml dependencies", r.packageAdd.deny === null);

  console.log("PyPI: pip / uv / poetry");
  r = await run("pip install reqeusts", root, fakeNet({ pypi: { reqeusts: pypiDoc() } }));
  check("pip typosquat reqeusts", rules(r).includes("typosquat") && r.packageAdd.deny.includes("requests"));
  r = await run("uv add fresh-lib", root, fakeNet({ pypi: { "fresh-lib": pypiDoc({ latestAge: 1 }) } }));
  check("uv add of a 1-day-old release -> release-age, safe version named", rules(r).includes("release-age") && r.packageAdd.deny.includes("fresh-lib@1.0.0"), r.packageAdd.deny ?? "");
  r = await run("poetry add mid-lib==2.0.0", root, fakeNet({ pypi: { "mid-lib": pypiDoc() }, osv: { "mid-lib@2.0.0": ["PYSEC-2026-1"] } }));
  check("poetry add: OSV hit on the pinned version (ecosystem PyPI)", rules(r).includes("osv") && r.packageAdd.deny.includes("PYSEC-2026-1"));
  const sent = [];
  const spy = fakeNet({ pypi: { "mid-lib": pypiDoc() } });
  await run("uv pip install mid-lib", root, async (u, i) => { if (i?.body) sent.push(JSON.parse(i.body)); return spy(u, i); });
  eq("OSV query shape", sent[0]?.queries[0], { package: { name: "mid-lib", ecosystem: "PyPI" }, version: "2.0.0" });

  console.log("cache");
  const cacheDir = tmp("cache-warm-");
  net = fakeNet({ npm: { "tiny-lib": npmDoc() }, pypi: { "mid-lib": pypiDoc() } });
  await run("pnpm add tiny-lib && pip install mid-lib", root, net, { cacheDir });
  const cold = net.calls.length;
  r = await run("pnpm add tiny-lib && pip install mid-lib", root, net, { cacheDir });
  check("cold run fetched, warm run made ZERO fetches", cold === 5 && net.calls.length === cold, `${cold} -> ${net.calls.length}`);
  r = await run("pnpm add tiny-lib", root, net, { cacheDir, now: NOW + 7 * 3_600_000 });
  check("OSV cache expires after 6 h (registry/downloads still warm)", net.calls.length === cold + 1 && net.calls.at(-1).includes("osv.dev"));

  console.log("failure handling");
  r = await run("pnpm add tiny-lib", root, fakeNet({ down: true }));
  check("network down: allowed with a warning", r.packageAdd.deny === null && r.packageAdd.warnings.some((w) => w.includes("could not verify tiny-lib")), JSON.stringify(r.packageAdd));
  net = fakeNet({ npm: { "tiny-lib": npmDoc() } });
  const flaky = async (u, i) => { if (u.includes("osv.dev")) throw new Error("osv down"); return net(u, i); };
  r = await run("pnpm add tiny-lib", root, flaky);
  check("OSV down: warning, no deny", r.packageAdd.deny === null && r.packageAdd.warnings.some((w) => w.includes("OSV lookup failed")));
  const t0 = Date.now();
  r = await run("pnpm add slow-lib", root, (u, i) => new Promise((_, rej) => { const keep = setTimeout(() => {}, 5000); i.signal.addEventListener("abort", () => { clearTimeout(keep); rej(new Error("aborted")); }); }), { budgetMs: 300 });
  check("a hanging request is cut by the time budget and allowed with a warning", Date.now() - t0 < 2500 && r.packageAdd.deny === null && r.packageAdd.warnings.length >= 1, `${Date.now() - t0} ms`);

  console.log("deps.exceptions override");
  const exc = tmp("proj-exc-");
  mkdirSync(join(exc, "docs"));
  writeFileSync(join(exc, "docs", "decisions.md"), "## D090 | 2026-11-19 | accepted risk\n");
  writeFileSync(join(exc, "maple.config.json"), JSON.stringify({ deps: { exceptions: [{ name: "tiny-lib", decision: "D090", why: "vendor-approved, vuln not reachable" }] } }));
  r = await run("pnpm add tiny-lib", exc, fakeNet({ npm: { "tiny-lib": npmDoc() }, osv: { "tiny-lib@1.1.0": ["GHSA-x"] }, downloads: { "tiny-lib": 1 } }));
  check("a D###-backed exception silences every finding of the package", r.packageAdd.deny === null, r.packageAdd.deny ?? "");

  console.log("batch result shape");
  const direct = await checkPackageAdds(parseAdds("pnpm add tiny-lib"), root, { fetchImpl: fakeNet({ npm: { "tiny-lib": npmDoc() }, osv: { "tiny-lib@1.1.0": ["GHSA-y"] } }), now: NOW, cacheDir: tmp("cache-"), topDir: top });
  eq("findings carry package + rule", direct.findings.map((f) => [f.pkg, f.rule]), [["tiny-lib", "osv"]]);
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
