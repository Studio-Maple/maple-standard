#!/usr/bin/env node
// Unit tests for the production-migration approval library, the owner CLI and the guard's parsing helpers.
// (The allow / deny matrix through the dispatcher lives in fixtures/prod-migration-guard.json.)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PD = join(HERE, "..", "predeploy");
const lib = await import(pathToFileURL(join(PD, "migration-approval.mjs")).href);
const cli = await import(pathToFileURL(join(PD, "approve-prod-migration.mjs")).href);
const guard = await import(pathToFileURL(join(HERE, "..", "..", "hooks", "guards", "prod-migration-guard.mjs")).href);
const { failClosed } = guard;

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };
const NOW = Date.parse("2026-11-12T10:00:00Z");
const good = () => lib.buildApproval({ projectRef: "prodref0000000000000", versions: ["20261004130000", "20261004120000"], now: NOW });

t("buildApproval sorts versions and defaults to a 30 minute TTL", () => {
  const a = good();
  assert.deepEqual(a.versions, ["20261004120000", "20261004130000"]);
  assert.equal(Date.parse(a.expiresAt) - Date.parse(a.issuedAt), 30 * 60_000);
  assert.equal(a.issuedBy, "owner-cli");
});

for (const [name, args] of [
  ["no ref", { versions: ["20261004120000"] }],
  ["no versions", { projectRef: "prodref0000000000000", versions: [] }],
  ["a short version", { projectRef: "prodref0000000000000", versions: ["2026"] }],
  ["a version with a suffix", { projectRef: "prodref0000000000000", versions: ["20261004120000_x"] }],
  ["ttl 0", { projectRef: "prodref0000000000000", versions: ["20261004120000"], ttlMinutes: 0 }],
  ["ttl too long", { projectRef: "prodref0000000000000", versions: ["20261004120000"], ttlMinutes: 9999 }],
  ["ttl NaN", { projectRef: "prodref0000000000000", versions: ["20261004120000"], ttlMinutes: NaN }],
]) t(`buildApproval rejects ${name}`, () => assert.throws(() => lib.buildApproval(args)));

t("validateApproval accepts a fresh approval", () => assert.equal(lib.validateApproval(good(), NOW + 1000).ok, true));
t("validateApproval rejects an expired approval", () => assert.match(lib.validateApproval(good(), NOW + 31 * 60_000).reason, /expired/));
t("validateApproval rejects a foreign issuer", () => assert.equal(lib.validateApproval({ ...good(), issuedBy: "agent" }, NOW).ok, false));
t("validateApproval rejects a future issuedAt", () => assert.match(lib.validateApproval(good(), NOW - 3_600_000).reason, /future/));
t("validateApproval rejects a stretched lifetime", () => assert.match(lib.validateApproval({ ...good(), expiresAt: "2030-01-01T00:00:00Z" }, NOW).reason, /lifetime/));
t("validateApproval rejects junk", () => { for (const j of [null, "x", 5, [], {}]) assert.equal(lib.validateApproval(j, NOW).ok, false); });

t("write / read round trip through a git common dir; worktrees share it", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pma-")));
  try {
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i"], { cwd: root });
    spawnSync("git", ["worktree", "add", "-q", ".worktrees/w", "-b", "agent/w"], { cwd: root });
    const common = lib.gitCommonDir(root);
    assert.equal(lib.readApproval(common).missing, true);
    const file = lib.writeApproval(common, lib.buildApproval({ projectRef: "prodref0000000000000", versions: ["20261004120000"] }));
    assert.equal(file, lib.approvalPath(common));
    assert.equal(lib.readApproval(common).ok, true);
    assert.equal(lib.gitCommonDir(join(root, ".worktrees", "w")).replace(/\\/g, "/"), common.replace(/\\/g, "/"));
    assert.equal(lib.readApproval(lib.gitCommonDir(join(root, ".worktrees", "w"))).ok, true);
    assert.equal(lib.gitCommonDir(tmpdir()) === null || typeof lib.gitCommonDir(tmpdir()) === "string", true);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", ".worktrees/w"], { cwd: root });
    rmSync(root, { recursive: true, force: true });
  }
});

t("localMigrationVersions lists digit-prefixed .sql files only", () => {
  const root = mkdtempSync(join(tmpdir(), "pma-"));
  try {
    mkdirSync(join(root, "migrations"));
    for (const f of ["20261004130000_b.sql", "20261004120000_a.sql", "README.md", "seed.sql", "x_20261004.sql"]) {
      spawnSync(process.execPath, ["-e", `require('fs').writeFileSync(process.argv[1],'')`, join(root, "migrations", f)]);
    }
    assert.deepEqual(lib.localMigrationVersions(root), ["20261004120000", "20261004130000"]);
    assert.equal(lib.localMigrationVersions(join(root, "nope")), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

t("approveCommand prints the exact owner command", () => {
  assert.equal(lib.approveCommand("/p/a.mjs", "abc123", ["20261004120000"]), 'node "/p/a.mjs" --project-ref abc123 20261004120000');
  assert.match(lib.approveCommand("/p/a.mjs", undefined, []), /<project-ref> <version>/);
});

t("CLI parseArgs", () => {
  assert.deepEqual(cli.parseArgs(["--project-ref", "abc123", "20261004120000", "--ttl-minutes", "10"]), { versions: ["20261004120000"], ttlMinutes: 10, projectRef: "abc123" });
  assert.equal(cli.parseArgs(["--project-ref=abc123"]).projectRef, "abc123");
  assert.throws(() => cli.parseArgs(["--yes"]));
});

const SCRIPT = join(PD, "approve-prod-migration.mjs");
t("CLI refuses without an interactive terminal and writes nothing", () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "pma-")));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    const r = spawnSync(process.execPath, [SCRIPT, "--project-ref", "prodref0000000000000", "20261004120000"], { cwd: root, encoding: "utf8", input: "prodref0000000000000\n" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /interactive terminal/);
    assert.equal(existsSync(join(root, ".git", "maple", "prod-migration-approval.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
t("CLI usage errors exit 2", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--project-ref", "prodref0000000000000", "not-a-version"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

t("dbUrlHost", () => {
  const h = guard.dbUrlHost;
  assert.equal(h("postgresql://u:p@localhost:54322/postgres"), "localhost");
  assert.equal(h("postgresql://u:p@[::1]:54322/postgres"), "[::1]");
  assert.equal(h("postgres://localhost:x@evil.com/db"), "evil.com");
  assert.equal(h("postgresql://u:p%40q@db.abc.supabase.co/postgres"), "db.abc.supabase.co");
  assert.equal(h("postgresql://u:p@localhost/db?host=evil.com"), null);
  assert.equal(h("host=localhost dbname=x"), null);
});
t("dbUrlRef only trusts Supabase hosts", () => {
  assert.equal(guard.dbUrlRef("postgresql://postgres:p@db.abcdefgh.supabase.co:5432/postgres"), "abcdefgh");
  assert.equal(guard.dbUrlRef("postgresql://postgres.abcdefgh:p@aws-0-eu.pooler.supabase.com:6543/postgres"), "abcdefgh");
  assert.equal(guard.dbUrlRef("postgresql://postgres.abcdefgh:p@evil.example.com:6543/postgres"), undefined);
});

t("failClosed fires only on migration-shaped shell commands", () => {
  const ctx = (command, tool = "Bash") => ({ tool, command });
  assert.ok(failClosed(ctx("supabase migration repair --status applied 1"), "x").deny);
  assert.ok(failClosed(ctx("npx supabase db push"), "x").deny);
  assert.equal(failClosed(ctx("ls"), "x"), undefined);
  assert.equal(failClosed({ tool: "Read", command: "" }, "x"), undefined);
});

console.log(`\n${n} prod-migration tests passed`);
