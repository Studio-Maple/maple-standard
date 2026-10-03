// remote leg: the gate must trigger the workflow by pushing the tag predeploy/<sha> (no dispatch input),
// reuse a green run, and re-push a stale tag. `gh` is faked via ctx.gh; git is real against a bare origin.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRemote } from "./remote.mjs";

const base = mkdtempSync(join(tmpdir(), "predeploy-remote-"));
const g = (cwd, args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8" }); assert.equal(r.status, 0, args.join(" ") + r.stderr); return r.stdout.trim(); };
const origin = join(base, "origin.git"), repo = join(base, "repo");
spawnSync("git", ["init", "-q", "--bare", origin]);
spawnSync("git", ["init", "-q", repo]);
g(repo, ["config", "user.email", "t@t"]); g(repo, ["config", "user.name", "t"]); g(repo, ["config", "commit.gpgsign", "false"]);
g(repo, ["checkout", "-q", "-b", "development"]);
writeFileSync(join(repo, "a"), "x"); g(repo, ["add", "-A"]); g(repo, ["commit", "-q", "-m", "c"]);
g(repo, ["remote", "add", "origin", origin]); g(repo, ["push", "-q", "origin", "development"]);
const sha = g(repo, ["rev-parse", "HEAD"]);
const pd = { remote: { workflow: "w.yml", pollSec: 0.01 } };
const check = { github: "w.yml" };

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

// fake gh: no runs until the tag exists on origin, then one green run for sha. Records every call.
const calls = [];
const fakeGh = (_root, args) => {
  calls.push(args.join(" "));
  const tagged = g(origin, ["tag", "-l", `predeploy/${sha}`]);
  if (args[0] === "run" && args[1] === "list") {
    return { status: 0, err: "", out: JSON.stringify(tagged ? [{ databaseId: 7, headSha: sha, status: "completed", conclusion: "success", createdAt: new Date().toISOString(), url: "u" }] : []) };
  }
  if (args[0] === "run" && args[1] === "view") return { status: 0, err: "", out: JSON.stringify({ status: "completed", conclusion: "success", jobs: [], url: "u", headSha: sha }) };
  return { status: 1, err: "unexpected " + args.join(" "), out: "" };
};

await t("pushes predeploy/<sha> tag, never dispatches, passes with no inputs", async () => {
  const r = await runRemote(check, pd, { root: repo, sha, gh: fakeGh });
  assert.deepEqual(r.findings, []);
  assert.equal(g(origin, ["tag", "-l", `predeploy/${sha}`]), `predeploy/${sha}`);
  assert.equal(g(origin, ["rev-parse", `predeploy/${sha}^{commit}`]), sha);
  assert.ok(!calls.some((c) => c.includes("workflow run") || c.includes(" -f ")), "no dispatch / -f input");
  assert.ok(calls.every((c) => !c.startsWith("run list") || c.includes("--event push")));
});

await t("a green run for the sha is reused without re-pushing the tag", async () => {
  const before = g(origin, ["for-each-ref", "refs/tags"]);
  const r = await runRemote(check, pd, { root: repo, sha, gh: fakeGh });
  assert.equal(r.meta.reused, true);
  assert.equal(g(origin, ["for-each-ref", "refs/tags"]), before);
});

await t("unpushed candidate is a finding", async () => {
  writeFileSync(join(repo, "a"), "y"); g(repo, ["commit", "-q", "-am", "d"]);
  const r = await runRemote(check, pd, { root: repo, sha: g(repo, ["rev-parse", "HEAD"]), gh: fakeGh });
  assert.equal(r.findings[0].id, "sha-not-on-remote");
});

console.log(`${n} remote tests passed`);
