#!/usr/bin/env node
// link-guard regression (EasyCaller 2026-10-09): a worktree's site/node_modules was a junction to the main
// checkout's; `(cd site && npm ci)` in the worktree emptied the MAIN install. Real junctions (Windows) /
// symlinks (Unix) in a temp dir; asserts the dispatcher's verdict and that nothing was touched.
//   node plugin/scripts/hooks/link-guard.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const { evaluate } = await import(pathToFileURL(join(HERE, "..", "..", "hooks", "guard.mjs")).href);
const fwd = (p) => p.replace(/\\/g, "/");

const root = fwd(realpathSync.native(mkdtempSync(join(tmpdir(), "link-guard-"))));
const main = `${root}/main`;
const wt = `${main}/.worktrees/w1`;
const links = [];
const mk = (p, files = {}) => { mkdirSync(p, { recursive: true }); for (const [f, c] of Object.entries(files)) writeFileSync(join(p, f), c); };
const link = (target, at) => { symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir"); links.push(at); };

mk(`${main}/site/node_modules/pkg`, { "index.js": "x" });
mk(`${main}/node_modules/root-pkg`, { "index.js": "x" });
mk(`${main}/app/node_modules/app-pkg`, { "index.js": "x" });
mk(`${wt}/site`, { "package.json": "{}" });
mk(`${wt}/app`, { "package.json": "{}" });
mk(`${wt}/own`, { "package.json": "{}" });
mk(`${wt}/own/node_modules/real`, { "index.js": "x" });
writeFileSync(`${wt}/package.json`, JSON.stringify({ workspaces: ["app"] }));
mk(`${wt}/plain`, { "package.json": "{}" });
writeFileSync(`${wt}/plain/package.json`, JSON.stringify({ workspaces: ["app"] }));
link(`${main}/site/node_modules`, `${wt}/site/node_modules`);
link(`${main}/app/node_modules`, `${wt}/app/node_modules`);

let failed = 0;
async function t(name, tool, command, expect, match, cwd = wt) {
  const res = await evaluate({ tool_name: tool, cwd, tool_input: { command } });
  const got = res.deny && /link-guard/.test(res.deny) ? "deny" : "allow";
  try {
    assert.equal(got, expect, `${got} (deny: ${res.deny ?? "-"})`);
    if (match) assert.match(res.deny, match);
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}

// paths are quoted: the temp dir can contain a space (C:/Users/First Last/...)
const W = (p = "") => `"${wt}${p}"`;
const M = (p = "") => `"${main}${p}"`;
const WW = (p = "") => `"${(wt + p).replace(/\//g, "\\")}"`;

try {
  // the incident
  await t("npm ci in a worktree's linked site/", "Bash", `cd ${W()} && (cd site && npm ci)`, "deny", /site\/node_modules is a link to .*main.*cmd \/\/c rmdir/s);
  await t("npm ci, absolute cd", "Bash", `cd ${W("/site")} && npm ci --no-audit`, "deny");
  await t("npm --prefix into a linked dir", "Bash", `npm --prefix ${W("/site")} ci`, "deny");
  await t("npm install <pkg>", "Bash", `cd ${W("/site")} && npm install left-pad`, "deny");
  await t("npm i alias", "Bash", `cd ${W("/site")} && npm i`, "deny");
  await t("pnpm add", "Bash", `cd ${W("/site")} && pnpm add zod`, "deny");
  await t("bare yarn installs", "Bash", `cd ${W("/site")} && yarn`, "deny");
  await t("PowerShell Set-Location + npm ci", "PowerShell", `Set-Location ${WW("/site")}; npm ci`, "deny");
  await t("root install whose workspace member is linked", "Bash", `cd ${W()} && npm ci`, "deny", /app\/node_modules/);
  // allowed: reads, real dirs, global, the main checkout itself
  await t("npm run build in a linked dir", "Bash", `cd ${W("/site")} && npm run build`, "allow");
  await t("npm ls in a linked dir", "Bash", `cd ${W("/site")} && npm ls --depth=0`, "allow");
  await t("npm ci where node_modules is real", "Bash", `cd ${W("/own")} && npm ci`, "allow");
  await t("npm ci in the main checkout", "Bash", `cd ${M("/site")} && npm ci`, "allow");
  await t("global install", "Bash", `cd ${W("/site")} && npm install -g npm`, "allow");
  await t("npm ci mentioned in a commit message", "Bash", `cd ${W()} && git commit -m "run (cd site && npm ci)"`, "allow");
  // deletes
  await t("rm -rf under the link", "Bash", `rm -rf ${W("/site/node_modules/pkg")}`, "deny", /inside/);
  await t("rm -rf link/*", "Bash", `cd ${W()} && rm -rf site/node_modules/*`, "deny");
  await t("rm -rf link/ (trailing slash)", "Bash", `cd ${W()} && rm -rf site/node_modules/`, "deny");
  await t("rm -rf the link itself", "Bash", `cd ${W()} && rm -rf site/node_modules`, "deny", /rmdir/);
  await t("Remove-Item -Recurse on the link", "PowerShell", `Remove-Item -Recurse -Force ${WW("/site/node_modules")}`, "deny");
  await t("cmd rmdir /s under the link", "Bash", `cmd //c rmdir /s /q ${WW("/site/node_modules/pkg")}`, "deny");
  await t("npx rimraf the link contents", "Bash", `cd ${W()} && npx rimraf site/node_modules/pkg`, "deny");
  await t("plain rmdir of the link (the safe unlink)", "Bash", `cmd //c rmdir ${WW("/site/node_modules")}`, "allow");
  await t("rm (no -r) of the link", "Bash", `rm ${W("/site/node_modules")}`, "allow");
  await t("rm -rf a real node_modules", "Bash", `rm -rf ${W("/own/node_modules")}`, "allow");
  await t("rm -rf unrelated dir", "Bash", `rm -rf ${W("/dist")}`, "allow");
  // config switch
  writeFileSync(`${wt}/maple.config.json`, JSON.stringify({ project: { name: "x" }, hooks: { bashGuard: { linkGuardEnabled: false } } }));
  // projectConfig is memoised per cwd, so this case runs from a cwd not used above
  await t("linkGuardEnabled=false", "Bash", `cd ${W("/site")} && npm ci`, "allow", undefined, `${wt}/app`);

  // the guard never touched the targets
  assert.deepEqual(readdirSync(`${main}/site/node_modules`), ["pkg"]);
  assert.deepEqual(readdirSync(`${main}/app/node_modules`), ["app-pkg"]);
} finally {
  for (const l of links) { try { unlinkSync(l); } catch { /* already gone */ } } // links first: never recurse through them
  rmSync(root, { recursive: true, force: true });
}

if (failed) { console.error(`\n${failed} link-guard case(s) failed`); process.exit(1); }
console.log("\nlink-guard: all cases passed");
