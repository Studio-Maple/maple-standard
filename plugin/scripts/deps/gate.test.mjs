#!/usr/bin/env node
// Integration test for check-dep-freshness.mjs (D064): a real temp git repo, a stubbed registry.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./check-dep-freshness.mjs";

// A pre-push hook exports GIT_DIR & co; left in place they would aim every git call below at the REAL repo.
for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const sandbox = mkdtempSync(join(tmpdir(), "dep-fresh-"));
if (!sandbox.startsWith(tmpdir())) throw new Error("sandbox escaped tmpdir");
const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: sandbox, stdio: "ignore" });
const write = (rel, obj) => {
  const path = join(sandbox, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
};
const LATEST = { react: "19.2.7", zod: "4.4.3", lodash: "4.18.0", tiny: "0.12.0" };
const fetchImpl = async (url) => {
  const name = decodeURIComponent(url.split("/").slice(3).join("/"));
  if (name === "offline") throw new Error("ECONNREFUSED");
  if (!LATEST[name]) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ "dist-tags": { latest: LATEST[name] }, versions: { [LATEST[name]]: {} }, time: { [LATEST[name]]: "2020-01-01T00:00:00Z" } }) };
};
const gate = async () => run({ root: sandbox, fetchImpl });

try {
  git("init", "-b", "main");
  write("package.json", { name: "app", dependencies: { react: "^18.0.0" } });
  write("maple.config.json", { repo: { devBranch: "main" } });
  git("add", "-A");
  git("commit", "-m", "base");

  let r = await gate();
  check("nothing changed -> pass, quiet", r.errors === 0 && r.lines.some((l) => l.includes("no dependency added or changed")), r.lines.join(" | "));

  write("package.json", { name: "app", scripts: { x: "y" }, dependencies: { react: "^18.0.0" } });
  r = await gate();
  check("untouched stale dep is not checked (Dependabot's job)", r.errors === 0, r.lines.join(" | "));

  write("package.json", { name: "app", dependencies: { react: "^18.0.0", zod: "^3.0.0" } });
  r = await gate();
  check("added stale dep fails", r.errors === 1 && r.lines.some((l) => l.includes("zod@^3.0.0") && l.includes("4.4.3")), r.lines.join(" | "));

  write("package.json", { name: "app", dependencies: { react: "^19.0.0", zod: "^4.0.0" } });
  r = await gate();
  check("changed + added current deps pass", r.errors === 0 && r.lines.some((l) => l.includes("2 added/changed")), r.lines.join(" | "));

  write("package.json", { name: "app", dependencies: { react: "^18.0.0", zod: "^4.0.0", local: "workspace:*", fl: "file:../x", al: "npm:zod@^4.1.0" } });
  r = await gate();
  check("workspace/file skipped, alias resolved to target", r.errors === 0 && r.lines.some((l) => l.includes("2 skipped")) , r.lines.join(" | "));

  write("package.json", { name: "app", dependencies: { react: "^18.0.0", al: "npm:zod@^3.0.0" } });
  r = await gate();
  check("stale alias fails against target", r.errors === 1, r.lines.join(" | "));

  write("package.json", { name: "app", dependencies: { react: "^18.0.0", offline: "^1.0.0" } });
  r = await gate();
  check("unreachable registry fails loudly", r.errors === 1 && r.lines.some((l) => l.includes("unreachable")), r.lines.join(" | "));

  write("package.json", { name: "app", dependencies: { react: "^18.0.0", nosuch: "^1.0.0" } });
  r = await gate();
  check("404 from the registry fails", r.errors === 1, r.lines.join(" | "));

  write("packages/web/package.json", { name: "web", devDependencies: { lodash: "^3.0.0" } });
  write("package.json", { name: "app", dependencies: { react: "^18.0.0" } });
  r = await gate();
  check("untracked nested package.json is scanned", r.errors === 1 && r.lines.some((l) => l.includes("packages/web/package.json")), r.lines.join(" | "));

  // exceptions
  write("docs/decisions.md", "## D070 | 2026-10-05 | lodash 3 pinned\nbody\n");
  write("maple.config.json", { repo: { devBranch: "main" }, deps: { exceptions: [{ name: "lodash", range: "^3.0.0", decision: "D070", why: "legacy plugin API needs lodash 3" }] } });
  r = await gate();
  check("valid exception passes and is reported", r.errors === 0 && r.lines.some((l) => l.includes("excepted by D070")), r.lines.join(" | "));

  write("maple.config.json", { repo: { devBranch: "main" }, deps: { exceptions: [{ name: "lodash", range: "^3.0.0", decision: "D099", why: "legacy plugin API needs lodash 3" }] } });
  r = await gate();
  check("exception citing a missing D### is invalid and the dep still fails", r.errors === 2 && r.lines.some((l) => l.includes("D099")), r.lines.join(" | "));

  // committed changes on a feature branch count too
  rmSync(join(sandbox, "packages"), { recursive: true });
  write("maple.config.json", { repo: { devBranch: "main" } });
  git("add", "-A");
  git("commit", "-m", "settle");
  git("checkout", "-b", "feature");
  write("package.json", { name: "app", dependencies: { react: "^18.0.0", tiny: "^0.11.0" } });
  git("commit", "-am", "add tiny");
  r = await gate();
  check("committed 0.x-behind dep on a branch fails", r.errors === 1 && r.lines.some((l) => l.includes("tiny@^0.11.0")), r.lines.join(" | "));

  // no resolvable base
  const lonely = mkdtempSync(join(tmpdir(), "dep-fresh-lonely-"));
  execFileSync("git", ["init", "-b", "trunk"], { cwd: lonely, stdio: "ignore" });
  r = await run({ root: lonely, fetchImpl });
  check("unresolvable target branch fails loudly", r.errors === 1 && r.lines[0].includes("cannot resolve"), r.lines.join(" | "));
  rmSync(lonely, { recursive: true, force: true });
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
