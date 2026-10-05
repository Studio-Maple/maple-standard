#!/usr/bin/env node
// Unit tests for the dependency-freshness core (D064): semver floors, package.json diffing,
// install-command parsing, minimumReleaseAge selection, exception validation. Registry stubbed.
import { validateConfig } from "../validate-config.mjs";
import { checkInstallCommand } from "./install-guard.mjs";
import { validateExceptions, findException } from "./exceptions.mjs";
import { judgeDep } from "./freshness.mjs";
import { parseInstallSpecs } from "./install-cmd.mjs";
import { applyToolEdit, classifyDep, diffDeps } from "./pkgjson.mjs";
import { fetchLatestEligible, pickLatestEligible } from "./registry.mjs";
import { compareVersions, isBehind, isPrerelease, rangeFloor, sameBucket } from "./semver-lite.mjs";

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);
const fl = (spec) => { const f = rangeFloor(spec); return f ? `${f.major}.${f.minor}.${f.patch}` : null; };

console.log("semver-lite");
eq("caret floor", fl("^17.0.2"), "17.0.2");
eq("tilde partial", fl("~1.2"), "1.2.0");
eq("x-range", fl("1.x"), "1.0.0");
eq("exact", fl("19.2.7"), "19.2.7");
eq("v prefix", fl("v3.1.0"), "3.1.0");
eq("comparator set", fl(">=2 <4"), "2.0.0");
eq("spaced operator", fl(">= 2.3.0"), "2.3.0");
eq("upper bound only has floor 0", fl("<3"), "0.0.0");
eq("|| takes the newest branch", fl("^17 || ^18 || ^19"), "19.0.0");
eq("hyphen range", fl("1.2.3 - 2.0.0"), "1.2.3");
eq("> is strictly above", fl(">1.2.3"), "1.2.4");
eq("prerelease floor", fl("^1.0.0-beta.2"), "1.0.0");
eq("star has no floor", fl("*"), null);
eq("dist-tag has no floor", fl("latest"), null);
eq("empty has no floor", fl(""), null);
check("compare orders prerelease below release", compareVersions("1.0.0-rc.1", "1.0.0") < 0);
check("isPrerelease", isPrerelease("2.0.0-beta.1") && !isPrerelease("2.0.0"));
check("behind: ^17 vs 19.2.7", isBehind("^17.0.0", "19.2.7"));
check("not behind: ^19 vs 19.2.7", !isBehind("^19.0.0", "19.2.7"));
check("not behind: same major lower minor", !isBehind("^19.0.0", "19.9.9"));
check("not behind: ahead of latest", !isBehind("^20.0.0", "19.2.7"));
check("0.x behind by minor", isBehind("^0.11.0", "0.12.3"));
check("0.x same minor ok", !isBehind("^0.12.0", "0.12.3"));
check("0.x spec vs 1.x latest is behind", isBehind("^0.12.0", "1.0.0"));
check("tag never behind", !isBehind("latest", "5.0.0"));
check("|| range admitting latest not behind", !isBehind("^17 || ^18 || ^19", "19.2.7"));
check("sameBucket same major", sameBucket("^9.39.0", "9"));
check("sameBucket different major", !sameBucket("^9.39.0", "^10.0.0"));
check("sameBucket 0.x needs same minor", sameBucket("^0.11.2", "0.11.0") && !sameBucket("^0.11.2", "0.12.0"));

console.log("package.json diffing");
const before = { name: "x", scripts: { a: "1" }, dependencies: { react: "19.2.7", zod: "^4.0.0" }, devDependencies: { vitest: "^4.1.0" } };
eq("added dep", diffDeps(before, { ...before, dependencies: { ...before.dependencies, left: "^1.0.0" } }).map((d) => d.name), ["left"]);
eq("changed spec", diffDeps(before, { ...before, dependencies: { ...before.dependencies, zod: "^3.0.0" } }).map((d) => [d.name, d.was, d.spec]), [["zod", "^4.0.0", "^3.0.0"]]);
eq("removal ignored", diffDeps(before, { ...before, dependencies: { react: "19.2.7" } }), []);
eq("scripts edit ignored", diffDeps(before, { ...before, scripts: { a: "2" } }), []);
eq("moving a dep between sections counts as added", diffDeps(before, { ...before, dependencies: { react: "19.2.7" }, devDependencies: { vitest: "^4.1.0", zod: "^4.0.0" } }).map((d) => d.section), ["devDependencies"]);
eq("peer and optional sections covered", diffDeps({}, { peerDependencies: { a: "1" }, optionalDependencies: { b: "2" } }).map((d) => d.section), ["peerDependencies", "optionalDependencies"]);
eq("new file diffs against nothing", diffDeps({}, before).length, 3);
eq("non-object input safe", diffDeps(null, undefined), []);

console.log("spec classification");
eq("workspace skipped", classifyDep("a", "workspace:*").skip !== undefined, true);
eq("file skipped", classifyDep("a", "file:../a").skip !== undefined, true);
eq("link skipped", classifyDep("a", "link:../a").skip !== undefined, true);
eq("git url skipped", classifyDep("a", "git+https://github.com/x/y.git").skip !== undefined, true);
eq("github shorthand skipped", classifyDep("a", "user/repo").skip !== undefined, true);
eq("https tarball skipped", classifyDep("a", "https://x/y.tgz").skip !== undefined, true);
eq("catalog skipped", classifyDep("a", "catalog:").skip !== undefined, true);
eq("alias resolves", classifyDep("a", "npm:b@^2"), { name: "b", range: "^2" });
eq("scoped alias resolves", classifyDep("a", "npm:@s/b@^2.1.0"), { name: "@s/b", range: "^2.1.0" });
eq("bare alias has empty range", classifyDep("a", "npm:b"), { name: "b", range: "" });
eq("plain spec", classifyDep("a", "^1.0.0"), { name: "a", range: "^1.0.0" });

console.log("tool-edit application");
const text = JSON.stringify(before, null, 2);
check("Edit replaces once", JSON.parse(applyToolEdit("Edit", { old_string: '"zod": "^4.0.0"', new_string: '"zod": "^3.0.0"' }, text)).dependencies.zod === "^3.0.0");
check("Edit with missing old_string is null", applyToolEdit("Edit", { old_string: "nope", new_string: "x" }, text) === null);
check("MultiEdit applies in order", JSON.parse(applyToolEdit("MultiEdit", { edits: [{ old_string: '"a": "1"', new_string: '"a": "2"' }, { old_string: '"a": "2"', new_string: '"a": "3"' }] }, text)).scripts.a === "3");
check("Write returns content", applyToolEdit("Write", { content: "{}" }, text) === "{}");
check("replace_all", (applyToolEdit("Edit", { old_string: "^4", new_string: "^5", replace_all: true }, text).match(/\^5/g) ?? []).length === 2);

console.log("install-command parsing");
const names = (c) => parseInstallSpecs(c).map((s) => `${s.name}@${s.spec}`);
eq("pnpm add pinned", names("pnpm add react@17"), ["react@17"]);
eq("pnpm add bare ignored", names("pnpm add react"), []);
eq("dist-tags ignored", names("pnpm add react@latest zod@next foo@beta"), []);
eq("scoped caret", names("npm install @scope/foo@^2"), ["@scope/foo@^2"]);
eq("tilde", names("yarn add foo@~1"), ["foo@~1"]);
eq("bun add exact + dev flag", names("bun add -d foo@1.2.3"), ["foo@1.2.3"]);
eq("npm i alias", names("npm i foo@1 bar"), ["foo@1"]);
eq("pnpm i with args", names("pnpm i foo@2"), ["foo@2"]);
eq("pnpm install bare", names("pnpm install"), []);
eq("pnpm --filter value not a package", names("pnpm --filter web add foo@3"), ["foo@3"]);
eq("-F value and flags after", names("pnpm -F web add -D foo@3 --save-exact"), ["foo@3"]);
eq("compound command", names("cd /x && pnpm add a@1; echo hi | npm i b@2"), ["a@1", "b@2"]);
eq("quoted spec", names('pnpm add "foo@^3.1"'), ["foo@^3.1"]);
eq("npm alias spec", names("pnpm add foo@npm:bar@1"), ["foo@npm:bar@1"]);
eq("paths and urls ignored", names("pnpm add ./local github:u/r git+https://x/y.git ./a-1.0.0.tgz"), []);
eq("not an install", names("pnpm run build@1 && npm test"), []);
eq("pnpm remove ignored", names("pnpm remove foo@1"), []);
eq("npm -w consumes a value", names("npm i -w pkg-a foo@4"), ["foo@4"]);
eq("pnpm -w is a boolean", names("pnpm add -w foo@4"), ["foo@4"]);

console.log("minimumReleaseAge selection");
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-05T12:00:00Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const packument = {
  "dist-tags": { latest: "3.0.0" },
  versions: { "1.0.0": {}, "2.0.0": {}, "2.1.0": {}, "3.0.0-rc.1": {}, "3.0.0": {} },
  time: { "1.0.0": iso(300), "2.0.0": iso(100), "2.1.0": iso(5), "3.0.0-rc.1": iso(20), "3.0.0": iso(0.1) },
};
eq("no window -> latest tag", pickLatestEligible(packument, 0, NOW), "3.0.0");
eq("tag younger than window -> newest older release", pickLatestEligible(packument, 1440, NOW), "2.1.0");
eq("prereleases never eligible", pickLatestEligible(packument, 60 * 24 * 30, NOW), "2.0.0");
eq("tag older than window wins", pickLatestEligible({ ...packument, time: { ...packument.time, "3.0.0": iso(3) } }, 1440, NOW), "3.0.0");
eq("nothing old enough -> null", pickLatestEligible(packument, 60 * 24 * 1000, NOW), null);
eq("highest semver, not newest publish (backport)", pickLatestEligible({ "dist-tags": { latest: "3.0.0" }, versions: { "2.0.0": {}, "1.9.9": {} }, time: { "2.0.0": iso(50), "1.9.9": iso(40), "3.0.0": iso(0.1) } }, 1440, NOW), "2.0.0");

const stubFetch = (doc, status = 200) => async (url, init) => { stubFetch.calls.push({ url, accept: init.headers.accept }); return { ok: status === 200, status, json: async () => doc }; };
stubFetch.calls = [];
eq("fetch uses abbreviated doc without a window", await fetchLatestEligible("@s/p", { registry: "https://r.test", fetchImpl: stubFetch(packument) }), "3.0.0");
eq("scoped name url-encoded + abbreviated accept", [stubFetch.calls[0].url, stubFetch.calls[0].accept.includes("install-v1")], ["https://r.test/@s%2fp", true]);
await fetchLatestEligible("p", { registry: "https://r.test", fetchImpl: stubFetch(packument), minAgeMinutes: 1440, now: NOW });
check("full doc requested with a window", stubFetch.calls[1].accept === "application/json");
let threw = false;
try { await fetchLatestEligible("p", { fetchImpl: stubFetch({}, 503) }); } catch { threw = true; }
check("registry error throws", threw);

console.log("exceptions");
const ledger = "## D064 | 2026-10-05 | x\nbody\n\n## D070 | 2026-10-06 | y\n";
const good = { name: "eslint", range: "^9.39.0", decision: "D070", why: "eslint-config-next does not support 10 yet" };
eq("valid entry accepted", validateExceptions([good], ledger).valid.length, 1);
check("missing D### is invalid", validateExceptions([{ ...good, decision: "D999" }], ledger).problems[0]?.includes("D999 is not in the decisions ledger"));
check("bad decision shape", validateExceptions([{ ...good, decision: "70" }], ledger).problems.length === 1);
check("missing why", validateExceptions([{ ...good, why: "" }], ledger).problems.length === 1);
check("missing name", validateExceptions([{ ...good, name: "" }], ledger).problems.length === 1);
check("unreadable ledger invalidates", validateExceptions([good], null).problems[0]?.includes("unreadable"));
check("non-array rejected", validateExceptions({}, ledger).problems.length === 1);
eq("absent list is fine", validateExceptions(undefined, ledger), { valid: [], problems: [] });
check("D07 does not match D070 prefix", validateExceptions([{ ...good, decision: "D070" }], "## D0700 | z\n").problems.length === 1);
check("range matches same bucket", findException([good], ["eslint"], "9") !== undefined);
check("range rejects other major", findException([good], ["eslint"], "^10.0.0") === undefined);
check("no range covers all", findException([{ ...good, range: undefined }], ["eslint"], "^3") !== undefined);
check("matches alias target", findException([good], ["myeslint", "eslint"], "^9.1.0") !== undefined);

console.log("config validation");
const cfgOk = { project: { name: "a", slug: "a" }, deps: { exceptions: [good] } };
eq("valid deps config", validateConfig(cfgOk), []);
check("unknown deps key rejected", validateConfig({ ...cfgOk, deps: { nope: 1 } }).length === 1);
check("bad decision id rejected", validateConfig({ ...cfgOk, deps: { exceptions: [{ ...good, decision: "70" }] } }).some((e) => e.includes("decision")));
check("short why rejected", validateConfig({ ...cfgOk, deps: { exceptions: [{ ...good, why: "no" }] } }).some((e) => e.includes("why")));
check("exceptions must be an array", validateConfig({ ...cfgOk, deps: { exceptions: {} } }).length === 1);

console.log("judgeDep");
const latestFor = async (pkg) => ({ react: "19.2.7", ancient: "0.12.0" })[pkg] ?? (() => { throw new Error("registry answered 404 for " + pkg); })();
const ctx = { latestFor, exceptions: [{ name: "react", range: "^17.0.0", decision: "D070", why: "x".repeat(12) }] };
eq("stale", (await judgeDep({ name: "react", spec: "^18.0.0" }, ctx)).status, "stale");
eq("current", (await judgeDep({ name: "react", spec: "^19.0.0" }, ctx)).status, "ok");
eq("excepted", (await judgeDep({ name: "react", spec: "17.0.2" }, ctx)).status, "excepted");
eq("workspace skipped", (await judgeDep({ name: "react", spec: "workspace:*" }, ctx)).status, "skipped");
eq("alias checked against target", (await judgeDep({ name: "r", spec: "npm:react@^16" }, ctx)).status, "stale");
eq("unreachable", (await judgeDep({ name: "nope", spec: "^1.0.0" }, ctx)).status, "unreachable");
eq("tag skips lookup", (await judgeDep({ name: "nope", spec: "latest" }, ctx)).status, "ok");
eq("0.x minor behind", (await judgeDep({ name: "ancient", spec: "^0.11.0" }, ctx)).status, "stale");

console.log("install-guard");
const guardFetch = async (url) => {
  if (url.endsWith("/react")) return { ok: true, status: 200, json: async () => ({ "dist-tags": { latest: "19.2.7" } }) };
  throw new Error("offline");
};
const ROOT = "C:/definitely/not/a/project";
eq("denies pinned stale install", (await checkInstallCommand("pnpm add react@17", ROOT, { fetchImpl: guardFetch })).deny?.includes("19.2.7") ?? false, true);
eq("allows bare install without lookup", await checkInstallCommand("pnpm add react", ROOT, { fetchImpl: guardFetch }), { deny: null, warnings: [] });
eq("allows current pin", (await checkInstallCommand("pnpm add react@19", ROOT, { fetchImpl: guardFetch })).deny, null);
const offline = await checkInstallCommand("pnpm add other@1", ROOT, { fetchImpl: guardFetch });
check("network failure allows with a warning", offline.deny === null && offline.warnings.length === 1);

process.exit(failed ? 1 : 0);
