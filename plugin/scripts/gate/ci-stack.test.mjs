// D071 ci-stack unit set: the derived config (project id + EVERY port), refusals that protect the dev stack, lock rules, env output,
// and up/down driven against a mocked supabase CLI + docker (nothing real is started - the integration test does that).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../validate-config.mjs";
import { RefusalError, deriveCiConfig, readCiStackConfig } from "./ci-stack-config.mjs";
import { LABEL_KEY, busyPorts, removeProjectObjects } from "./ci-stack-docker.mjs";
import { formatEnv, parseEnvOutput, ciEnvFromStatus, stackEnvVars } from "./ci-stack-env.mjs";
import { lockHolder, releaseLock, takeLock } from "./ci-stack-lock.mjs";
import { assertSafeArgv, cmdDown, cmdEnv, cmdUp, ciPaths, makeCli } from "./ci-stack.mjs";
import { stackPorts } from "./gate-state.mjs";

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log("ok - " + name); };
const refuses = (fn, re) => assert.throws(fn, (e) => e instanceof RefusalError && re.test(e.message));

const DEV = ["# Ports: the 5632x block (comment mentions 56321 and stays as is)", 'project_id = "my-app-local"', "[api]", "enabled = true", "port = 56321", "[db]", "port = 56322", "shadow_port = 56320", "[db.pooler]", "enabled = false", "port = 56329", "[studio]", "port = 56323", "[local_smtp]", "port = 56324", "[analytics]", "port = 56327", "[auth]", 'site_url = "http://127.0.0.1:3000"', "[auth.external.github]", "enabled = true", ""].join("\n");
const cfg = { projectId: "my-app-local-ci", portBase: 56420 };

await t("derived config: project id renamed, EVERY port inside the CI block, no dev port left, OAuth off, comments untouched", () => {
  const d = deriveCiConfig(DEV, cfg);
  const lines = d.toml.split("\n");
  assert.ok(lines.includes('project_id = "my-app-local-ci"'));
  const ports = lines.filter((l) => /^\s*[a-z_]*port\s*=/.test(l)).map((l) => Number(l.split("=")[1]));
  assert.equal(ports.length, 7);
  for (const p of ports) assert.ok(p >= 56420 && p <= 56429, `port ${p} outside the block`);
  assert.equal(new Set(ports).size, 7, "ports are distinct");
  for (const dev of [56320, 56321, 56322, 56323, 56324, 56327, 56329]) assert.ok(!lines.some((l) => !l.startsWith("#") && new RegExp(`(?<![0-9])${dev}(?![0-9])`).test(l)), `dev port ${dev} leaked`);
  assert.ok(lines[0].includes("56321"), "comment lines are left alone");
  assert.deepEqual([d.ports.shadow, d.ports.api, d.ports.db, d.ports.studio], [56420, 56421, 56422, 56423], "role-stable slots");
  assert.ok(lines.some((l, i) => l === "enabled = false" && lines[i - 1] === "[auth.external.github]"));
  assert.equal(d.sourceProjectId, "my-app-local");
  assert.equal(d.siteUrl, "http://127.0.0.1:3000");
});

await t("derived config keeps CRLF and is independent of the dev block's numbers", () => {
  const d = deriveCiConfig(DEV.replace(/\n/g, "\r\n").replace(/563(\d\d)/g, "553$1"), cfg);
  assert.ok(d.toml.includes("\r\n") && !/[^\r]\n/.test(d.toml));
  assert.equal(d.ports.api, 56421);
});

await t("refusals: same project id, overlapping block, no project_id, no api/db port, too many ports", () => {
  refuses(() => deriveCiConfig(DEV, { projectId: "my-app-local", portBase: 56420 }), /equals the dev project_id/);
  refuses(() => deriveCiConfig(DEV, { projectId: "x-ci", portBase: 56322 }), /overlaps the dev stack's port/);
  refuses(() => deriveCiConfig(DEV.replace(/project_id.*\n/, ""), cfg), /no top-level project_id/);
  refuses(() => deriveCiConfig(DEV.replace("[api]\nenabled = true\nport = 56321\n", ""), cfg), /no api\.port/);
  const many = DEV + Array.from({ length: 5 }, (_, i) => `[extra${i}]\nport = ${60000 + i}`).join("\n");
  refuses(() => deriveCiConfig(many, cfg), /more than 10 ports/);
});

const mkRepo = (stack, toml = DEV) => {
  const root = mkdtempSync(join(tmpdir(), "ci-stack-"));
  const g = (...a) => assert.equal(spawnSync("git", a, { cwd: root }).status, 0, a.join(" "));
  g("init", "-q");
  mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
  writeFileSync(join(root, "supabase", "config.toml"), toml);
  writeFileSync(join(root, "supabase", "seed.sql"), "select 1;");
  writeFileSync(join(root, "supabase", ".env.local"), "SECRET=1");
  writeFileSync(join(root, "maple.config.json"), JSON.stringify({ ci: stack ? { stack } : {} }));
  return root;
};

await t("ci.stack: default project id <dev>-ci, absent -> null, bad portBase refused, stackPorts follows the block", () => {
  assert.equal(readCiStackConfig(mkRepo(null)), null);
  const r = mkRepo({ portBase: 56420 });
  assert.deepEqual(readCiStackConfig(r), { projectId: "my-app-local-ci", portBase: 56420, exclude: ["studio", "imgproxy", "logflare", "vector", "mailpit"] });
  assert.equal(readCiStackConfig(mkRepo({ portBase: 56420, projectId: "zz-ci", exclude: [] })).projectId, "zz-ci");
  refuses(() => readCiStackConfig(mkRepo({ portBase: "56420" })), /portBase/);
  assert.deepEqual(stackPorts(r), Array.from({ length: 10 }, (_, i) => 56420 + i));
  assert.ok(stackPorts(mkRepo(null)).includes(56321), "without ci.stack the dev config's ports are used");
});

await t("validate-config: ci.stack accepted when well-formed, every violation named", () => {
  const errs = (stack) => validateConfig({ project: { name: "p", slug: "p" }, repo: { devBranch: "main" }, ci: { stack } }).join("|");
  assert.equal(errs({ portBase: 56420, projectId: "a-ci", exclude: ["studio"] }), "");
  assert.equal(errs({ portBase: 56420 }), "");
  assert.match(errs({}), /ci\.stack\.portBase/);
  assert.match(errs({ portBase: 80 }), /ci\.stack\.portBase/);
  assert.match(errs({ portBase: 65530 }), /ci\.stack\.portBase/);
  assert.match(errs({ portBase: 56420, projectId: "bad id" }), /ci\.stack\.projectId/);
  assert.match(errs({ portBase: 56420, extra: 1 }), /ci\.stack\.extra: unknown key/);
  assert.match(errs({ portBase: 56420, exclude: "studio" }), /ci\.stack\.exclude/);
});

await t("lock: a live owner is never robbed, a dead owner's lock is reclaimed, same owner is re-entrant", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "ci-lock-")), "x.lock");
  assert.deepEqual(takeLock(dir, { pid: 111, alive: () => true }), { ok: true, reclaimed: false });
  assert.equal(lockHolder(dir), "111");
  const live = takeLock(dir, { pid: 222, alive: (p) => String(p) === "111" });
  assert.equal(live.ok, false);
  assert.match(live.reason, /another CI stack run is active \(owner pid 111\)/);
  assert.equal(lockHolder(dir), "111", "not stolen");
  assert.equal(takeLock(dir, { pid: 111, alive: () => true }).ok, true, "re-entrant for the owner");
  releaseLock(dir, 999);
  assert.equal(lockHolder(dir), "111", "only the owner releases");
  const dead = takeLock(dir, { pid: 333, alive: () => false });
  assert.deepEqual([dead.ok, dead.reclaimed], [true, true]);
  assert.equal(lockHolder(dir), "333");
  releaseLock(dir, 333);
  assert.equal(lockHolder(dir), null);
  mkdirSync(dir); // pid-less: its owner is between mkdir and the pid write
  assert.equal(takeLock(dir, { pid: 5, alive: () => false, graceSec: 120 }).ok, false);
  assert.equal(takeLock(dir, { pid: 5, alive: () => false, graceSec: -1 }).ok, true);
});

await t("env output: parse, port check against the CI block, sh/json/dotenv formats, quoting survives eval", () => {
  const d = deriveCiConfig(DEV, cfg);
  const status = parseEnvOutput(['API_URL="http://127.0.0.1:56421"', 'DB_URL="postgresql://postgres:postgres@127.0.0.1:56422/postgres"', 'ANON_KEY="anon-k"', 'SERVICE_ROLE_KEY="svc\'k"', "ignored line"].join("\n"));
  const env = ciEnvFromStatus(status, d, "/w");
  const vars = stackEnvVars(env);
  assert.equal(vars.SUPABASE_URL, "http://127.0.0.1:56421");
  assert.equal(vars.CI_SUPABASE_WORKDIR, "/w");
  const sh = formatEnv(vars, "sh");
  assert.match(sh, /^export SUPABASE_URL='http:\/\/127\.0\.0\.1:56421'$/m);
  const out = spawnSync("bash", ["-c", `eval '${sh.replace(/'/g, `'\\''`)}'; printf %s "$SUPABASE_SERVICE_ROLE_KEY"`], { encoding: "utf8" });
  assert.equal(out.stdout, "svc'k");
  assert.equal(JSON.parse(formatEnv(vars, "json")).SUPABASE_ANON_KEY, "anon-k");
  assert.match(formatEnv(vars, "dotenv"), /^SUPABASE_ANON_KEY="anon-k"$/m);
  refuses(() => formatEnv(vars, "yaml"), /unknown env format/);
  refuses(() => ciEnvFromStatus({ ...status, API_URL: "http://127.0.0.1:56321" }, d, "/w"), /not talking to my-app-local-ci/);
  refuses(() => ciEnvFromStatus(status, { ...d, ports: { ...d.ports, db: 56999 } }, "/w"), /CI database is on :56422|CI database is on :56999/);
});

await t("port probe: EACCES / EADDRINUSE and LISTENING sockets are reported", async () => {
  const bad = await busyPorts([1, 2, 3], { listen: async (p) => (p === 1 ? "EACCES" : null), listening: () => new Set([3]) });
  assert.deepEqual(bad, [{ port: 1, code: "EACCES" }, { port: 3, code: "LISTENING" }]);
});

// ---- fakes -----------------------------------------------------------------
const DEV_ID = "my-app-local";
const CI_ID = "my-app-local-ci";
function fakeDocker(objects) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    const kinds = { ps: "container", volume: "volume", network: "network" };
    const kind = kinds[args[0]];
    if (args[0] === "info") return { status: 0, stdout: "" };
    if (args[0] === "update") return { status: 0, stdout: "" };
    if (args[0] === "rm" || (args[1] === "rm")) {
      const id = args[args.length - 1];
      const i = objects.findIndex((o) => o.id === id);
      if (i >= 0) objects.splice(i, 1);
      return { status: 0, stdout: "" };
    }
    const filter = args[args.indexOf("--filter") + 1] ?? "";
    const want = filter.replace(`label=${LABEL_KEY}=`, "");
    const rows = objects.filter((o) => o.kind === kind && o.label === want).map((o) => `${o.id} ${o.label}`);
    return { status: 0, stdout: rows.join("\n") };
  };
  fn.calls = calls;
  return fn;
}
const seed = () => [
  { kind: "container", id: "dev_db", label: DEV_ID }, { kind: "volume", id: `supabase_db_${DEV_ID}`, label: DEV_ID }, { kind: "network", id: "dev_net", label: DEV_ID },
  { kind: "container", id: "ci_db", label: CI_ID }, { kind: "volume", id: `supabase_db_${CI_ID}`, label: CI_ID }, { kind: "network", id: "ci_net", label: CI_ID },
];

await t("docker teardown removes only objects labelled with the CI project and refuses a mislabelled row", () => {
  const objs = seed();
  const docker = fakeDocker(objs);
  assert.deepEqual(removeProjectObjects(docker, CI_ID), { removed: 3, failed: 0 });
  assert.deepEqual(objs.map((o) => o.id).sort(), ["dev_db", "dev_net", `supabase_db_${DEV_ID}`].sort());
  for (const c of docker.calls.filter((a) => a[0] === "rm" || a[1] === "rm")) assert.ok(!c.some((x) => /dev_|my-app-local$/.test(x)), `touched a dev object: ${c}`);
  assert.ok(!docker.calls.flat().some((a) => /--all|prune|-a$/.test(a) && a !== "-a"), "no prune/--all");
  const bad = (args) => (args[0] === "ps" ? { status: 0, stdout: `x ${DEV_ID}` } : { status: 0, stdout: "" });
  refuses(() => removeProjectObjects(bad, CI_ID), /carries project label "my-app-local"/);
  refuses(() => removeProjectObjects(docker, ""), /no CI project id/);
});

await t("supabase argv guard: workdir required, no --all/--linked/--db-url, project id pinned, --no-backup needs it", () => {
  const wd = "/w";
  assertSafeArgv(["stop", "--no-backup", "--project-id", CI_ID, "--workdir", wd], wd, CI_ID);
  refuses(() => assertSafeArgv(["stop", "--workdir", wd, "--all"], wd, CI_ID), /--all/);
  refuses(() => assertSafeArgv(["db", "reset", "--db-url=x", "--workdir", wd], wd, CI_ID), /--db-url/);
  refuses(() => assertSafeArgv(["status"], wd, CI_ID), /without --workdir/);
  refuses(() => assertSafeArgv(["stop", "--project-id", DEV_ID, "--workdir", wd], wd, CI_ID), /--project-id my-app-local/);
  refuses(() => assertSafeArgv(["stop", "--no-backup", "--workdir", wd], wd, CI_ID), /--no-backup without/);
});

// ---- up / down against mocks -------------------------------------------------
function mkCtx({ objects = seed(), busy = [], resetFails = 0, live = false, ownerPid = 4242 } = {}) {
  const root = mkRepo({ portBase: 56420 });
  const cfg2 = readCiStackConfig(root);
  const derived = deriveCiConfig(DEV, cfg2);
  const paths = ciPaths(join(root, ".git", "maple"), cfg2.projectId);
  const calls = [];
  let resets = 0;
  const run = (bin, argv, opts) => {
    calls.push({ argv, stdout: opts.stdout, cwd: opts.cwd, env: opts.env });
    if (argv[0] === "start") for (const o of [{ kind: "container", id: "ci_new", label: CI_ID }]) objects.push(o);
    if (argv[0] === "db" && resets++ < resetFails) return { status: 1, stderr: "DbSetupError" };
    if (argv[0] === "status") return { status: 0, stdout: `API_URL="http://127.0.0.1:${derived.ports.api}"\nDB_URL="postgresql://postgres:postgres@127.0.0.1:${derived.ports.db}/postgres"\nANON_KEY="the-anon"\nSERVICE_ROLE_KEY="the-svc"\n` };
    return { status: 0, stdout: "", stderr: "" };
  };
  const logs = [];
  const docker = fakeDocker(objects);
  const ctx = {
    root, env: { SUPABASE_URL: "http://dev:54321", E2E_SUPABASE_URL: "x", PATH: "p" }, log: (m) => logs.push(m), cfg: cfg2, derived, paths, projectId: cfg2.projectId, ownerPid,
    alive: () => live, docker, busyPorts: async () => busy, dockerWorks: () => true, sleep: () => {},
  };
  ctx.cli = makeCli({ paths, projectId: cfg2.projectId, bin: "supabase", run, env: ctx.env });
  return { ctx, calls, objects, logs, docker };
}

await t("up: lock, sweep, copy (no .env), start (-x, stdout suppressed), strip restart, db reset, env recorded; dev stack untouched", async () => {
  const { ctx, calls, objects } = mkCtx();
  assert.equal(await cmdUp(ctx), 0);
  assert.equal(lockHolder(ctx.paths.lock), "4242");
  const names = calls.map((c) => c.argv.slice(0, 2).join(" "));
  assert.deepEqual(names.filter((x) => /^(stop|start|db reset|status)/.test(x)).map((x) => x.split(" ")[0] === "db" ? "db reset" : x.split(" ")[0]), ["stop", "start", "db reset", "status"]);
  const start = calls.find((c) => c.argv[0] === "start");
  assert.equal(start.stdout, "ignore", "start's stdout (keys) is never captured");
  assert.deepEqual(start.argv.slice(0, 2), ["start", "-x"]);
  assert.equal(start.cwd, ctx.paths.workdir);
  assert.ok(calls.every((c) => c.argv.includes("--workdir") && c.argv.includes(ctx.paths.workdir)));
  assert.ok(calls.every((c) => !("SUPABASE_URL" in c.env) && !("E2E_SUPABASE_URL" in c.env) && c.env.PATH === "p"), "inherited stack env is scrubbed");
  assert.ok(existsSync(join(ctx.paths.projectDir, "seed.sql")) && !existsSync(join(ctx.paths.projectDir, ".env.local")));
  assert.match(readFileSync(ctx.paths.configPath, "utf8"), /project_id = "my-app-local-ci"/);
  assert.ok(ctx.docker.calls.some((a) => a[0] === "update" && a.includes("--restart=no")), "D052 restart policies stripped");
  assert.ok(objects.some((o) => o.id === "dev_db") && objects.some((o) => o.id === "dev_net") && objects.some((o) => o.id === `supabase_db_${DEV_ID}`), "dev objects survive");
  assert.ok(!objects.some((o) => o.id === "ci_db"), "the orphaned CI container was swept");
  assert.ok(existsSync(ctx.paths.envCache));
});

await t("up: db reset gets exactly one retry after the stack is healthy; a second failure tears down", async () => {
  const one = mkCtx({ resetFails: 1 });
  assert.equal(await cmdUp(one.ctx), 0);
  assert.equal(one.calls.filter((c) => c.argv[0] === "db").length, 2);
  const two = mkCtx({ resetFails: 2 });
  await assert.rejects(() => cmdUp(two.ctx), /supabase db reset failed/);
  assert.ok(!two.objects.some((o) => o.label === CI_ID), "failed up removed the CI objects");
  assert.ok(two.objects.some((o) => o.label === DEV_ID && o.kind === "container"), "and nothing of the dev stack");
});

await t("up: unbindable ports stop before start, with the netsh hint; a live other owner is refused", async () => {
  const busy = mkCtx({ busy: [{ port: 56421, code: "EACCES" }] });
  await assert.rejects(() => cmdUp(busy.ctx), /56421 \(EACCES\).*netsh/);
  assert.ok(!busy.calls.some((c) => c.argv[0] === "start"));
  const held = mkCtx({ live: true });
  mkdirSync(held.ctx.paths.lock, { recursive: true });
  writeFileSync(join(held.ctx.paths.lock, "pid"), "777\n");
  await assert.rejects(() => cmdUp(held.ctx), (e) => e instanceof RefusalError && /owner pid 777/.test(e.message));
  assert.equal(held.calls.length, 0, "nothing started or removed");
  assert.equal(held.objects.length, 6);
  assert.equal(lockHolder(held.ctx.paths.lock), "777", "a live pid's lock is never stolen");
});

await t("up reclaims a DEAD owner's lock and sweeps its orphans; down removes only the CI project, the workdir and the lock", async () => {
  const { ctx, objects } = mkCtx({ live: false });
  mkdirSync(ctx.paths.lock, { recursive: true });
  writeFileSync(join(ctx.paths.lock, "pid"), "777\n");
  await cmdUp(ctx);
  assert.equal(lockHolder(ctx.paths.lock), "4242");
  assert.equal(cmdDown(ctx), 0);
  assert.equal(lockHolder(ctx.paths.lock), null);
  assert.ok(!existsSync(ctx.paths.workdir));
  assert.deepEqual(objects.map((o) => o.id).sort(), ["dev_db", "dev_net", `supabase_db_${DEV_ID}`].sort());
  assert.equal(cmdDown(ctx), 0, "idempotent");
});

await t("env command prints exports for the recorded stack and nothing else; refuses when not up", async () => {
  const { ctx, logs } = mkCtx();
  assert.throws(() => cmdEnv(ctx), /not up/);
  await cmdUp(ctx);
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  try { cmdEnv(ctx, ["--format", "sh"]); } finally { process.stdout.write = orig; }
  const text = chunks.join("");
  assert.match(text, /^export SUPABASE_ANON_KEY='the-anon'$/m);
  assert.ok(!logs.some((l) => /the-anon|the-svc/.test(l)), "keys never reach the log");
});

console.log(`\nall ${n} ci-stack unit tests passed`);
