// Regression: the gitleaks preset scans the scan copy with a RELATIVE source, so path-anchored allowlists in the repo's
// .gitleaks.toml match (an absolute --source made gitleaks report absolute paths and every `^dir/file$` allowlist missed).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main as runGate } from "./run.mjs";
import { which } from "./lib.mjs";

if (!which("gitleaks")) { console.log("skip - gitleaks not installed"); process.exit(0); }
const repo = mkdtempSync(join(tmpdir(), "gitleaks-path-"));
const sh = (...a) => { const r = spawnSync("git", a, { cwd: repo, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
sh("init", "-q"); sh("config", "user.email", "t@t"); sh("config", "user.name", "t"); sh("config", "commit.gpgsign", "false");
const put = (f, c) => { mkdirSync(dirname(join(repo, f)), { recursive: true }); writeFileSync(join(repo, f), c); };
const KEY = "AKIAABCDEFGHIJKLMNOP";
put("maple.config.json", JSON.stringify({ project: { name: "t", slug: "t" }, predeploy: { checks: [{ id: "gitleaks", preset: "gitleaks", options: { history: false } }], exposure: { optOut: { bundle: { decision: "D161", why: "fixture repo: no web build to scan (the D072 opt-out path)" } } } } }));
put("docs/decisions.md", "# Decisions\n\n## D161 | 2026-10-01 | Test exception decision\nbody\n");
put("test/fixture.test.sh", `KEY=${KEY}\n`);
put(".gitleaks.toml", `[extend]\nuseDefault = true\n[[allowlists]]\ncondition = "AND"\ntargetRules = ["aws-access-token"]\npaths = ['''^test/fixture\.test\.sh$''']\nregexes = ['''^${KEY}$''']\n`);
sh("add", "-A"); sh("commit", "-q", "-m", "c");
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
assert.equal(await quiet(() => runGate(["--root", repo])), 0, "a path-anchored allowlist entry must match in the gate's scan copy");
put("test/other.sh", `KEY=${KEY}\n`); sh("add", "-A"); sh("commit", "-q", "-m", "c2");
assert.equal(await quiet(() => runGate(["--root", repo])), 1, "the same value in another file still fails");
console.log("ok - gitleaks path-anchored allowlists match in the gate; other files still fail\n\n1 gitleaks tests passed");
rmSync(repo, { recursive: true, force: true });
