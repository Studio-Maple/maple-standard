// D071 integration: REALLY brings this repo's isolated CI Supabase stack up and down and proves the dev stack (project_id from
// supabase/config.toml) is untouched - same containers (id + state), same volumes (name + creation time), ports still the dev's.
// Needs Docker and a bindable ci.stack block; skips (loudly) when the repo has no ci.stack or Docker is down.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LABEL_KEY, dockerRun } from "./ci-stack-docker.mjs";
import { readCiStackConfig, topLevelProjectId } from "./ci-stack-config.mjs";
import { dockerUsable as dockerWorks } from "./ci-stack-docker.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const CLI = join(HERE, "ci-stack.mjs");
const cfg = readCiStackConfig(ROOT);
if (!cfg) { console.log("(skipped - this repo has no ci.stack in maple.config.json)"); process.exit(0); }
if (!dockerWorks()) { console.log("(skipped - docker info fails)"); process.exit(0); }
const devId = topLevelProjectId(readFileSync(join(ROOT, "supabase", "config.toml"), "utf8"));

const docker = (...args) => { const r = dockerRun(args); assert.equal(r.status, 0, `docker ${args.join(" ")}: ${r.stderr}`); return String(r.stdout).trim(); };
const lines = (s) => s.split(/\r?\n/).filter(Boolean).sort();
const byLabel = (id) => `label=${LABEL_KEY}=${id}`;
const snapshot = (id) => ({
  containers: lines(docker("ps", "-a", "--filter", byLabel(id), "--format", "{{.ID}} {{.Names}} {{.State}}")),
  volumes: lines(docker("volume", "ls", "--filter", byLabel(id), "--format", "{{.Name}}")).map((v) => `${v} ${docker("volume", "inspect", "--format", "{{.CreatedAt}}", v)}`),
  networks: lines(docker("network", "ls", "--filter", byLabel(id), "--format", "{{.Name}}")),
});
const run = (args, owner = process.pid) => spawnSync(process.execPath, [CLI, ...args, "--root", ROOT, "--owner-pid", String(owner)], { encoding: "utf8", timeout: 25 * 60_000 });
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };

assert.notEqual(cfg.projectId, devId, "the CI project id must differ from the dev project id");
const devBefore = snapshot(devId);
assert.deepEqual(snapshot(cfg.projectId), { containers: [], volumes: [], networks: [] }, `leftovers of ${cfg.projectId} from an earlier run: run ci-stack.mjs down`);

try {
  await t("up: the CI stack starts on its own project id and port block", () => {
    const r = run(["up"]);
    assert.equal(r.status, 0, `up failed:\n${r.stderr}`);
    assert.ok(!/eyJ/.test(r.stdout + r.stderr), "no key may reach the log");
    const ci = snapshot(cfg.projectId);
    assert.ok(ci.containers.length >= 3, "gotrue/postgrest/kong/db containers exist");
    assert.ok(ci.containers.every((c) => c.includes(`_${cfg.projectId} `) || c.includes(`_${cfg.projectId}`)), "every CI container is named after the CI project");
    assert.ok(ci.volumes.some((v) => v.startsWith(`supabase_db_${cfg.projectId} `)), "its own db volume");
    const restart = docker("ps", "-aq", "--filter", byLabel(cfg.projectId)).split(/\s+/).map((id) => docker("inspect", "--format", "{{.HostConfig.RestartPolicy.Name}}", id));
    assert.ok(restart.every((p) => p === "no" || p === ""), `restart policies stripped (D052): ${restart}`);
  });

  await t("env: the tests' variables point at the CI block, never the dev ports", async () => {
    const r = run(["env"]);
    assert.equal(r.status, 0, r.stderr);
    const vars = Object.fromEntries(r.stdout.split(/\r?\n/).filter(Boolean).map((l) => /^export (\w+)='(.*)'$/.exec(l).slice(1, 3)));
    assert.equal(vars.SUPABASE_URL, `http://127.0.0.1:${cfg.portBase + 1}`);
    assert.match(vars.SUPABASE_DB_URL, new RegExp(`:${cfg.portBase + 2}/`));
    assert.ok(vars.SUPABASE_ANON_KEY && vars.CI_SUPABASE_WORKDIR.includes("ci-stack"));
    const health = await fetch(`${vars.SUPABASE_URL}/auth/v1/health`, { headers: { apikey: vars.SUPABASE_ANON_KEY } });
    assert.equal(health.status, 200, "the CI stack answers");
    assert.equal(run(["status"]).status, 0);
  });

  await t("a second run is refused while this owner is alive and nothing of the first is touched", () => {
    const before = snapshot(cfg.projectId);
    const r = run(["up"], process.ppid > 0 ? process.ppid : 1);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /another CI stack run is active/);
    assert.deepEqual(snapshot(cfg.projectId), before);
  });

  await t("the dev stack is untouched while the CI stack runs", () => {
    assert.deepEqual(snapshot(devId), devBefore);
  });
} finally {
  const down = run(["down"]);
  console.log(`down exit ${down.status}`);
}

await t("down: containers, volumes, networks and workdir of the CI project are gone; the dev stack is byte-for-byte as before", () => {
  assert.deepEqual(snapshot(cfg.projectId), { containers: [], volumes: [], networks: [] });
  assert.deepEqual(snapshot(devId), devBefore);
  assert.equal(run(["status"]).status, 1);
  const workdirs = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
  assert.ok(!existsSync(join(resolve(ROOT, workdirs), "maple", "ci-stack", cfg.projectId)), "workdir removed");
});

console.log(`\nall ${n} ci-stack integration tests passed`);
