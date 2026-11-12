// Owner-issued approval for production Supabase migrations (prod-migration-guard).
//
// File: <git-common-dir>/maple/prod-migration-approval.json (shared by every worktree of the repo)
//   { projectRef, versions: ["20261004120000", ...], issuedAt, expiresAt, issuedBy: "owner-cli" }
// Written ONLY by approve-prod-migration.mjs, which the owner runs in his own terminal; the PreToolUse guard
// denies every tool call that runs that script or touches the file. Read by the guard through readApproval().
// Pure helpers + small fs/git wrappers; no dependency on the rest of the predeploy gate.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const APPROVAL_FILE = "prod-migration-approval.json";
export const ISSUER = "owner-cli";
export const DEFAULT_TTL_MINUTES = 30;
export const MAX_TTL_MINUTES = 240;
export const VERSION_RE = /^\d{14}$/;
export const REF_RE = /^[a-z0-9][a-z0-9_-]{5,63}$/i;

/** <git-common-dir> for `dir`, absolute, or null when `dir` is not inside a git repository. */
export function gitCommonDir(dir) {
  try {
    const r = spawnSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const out = r.status === 0 ? r.stdout.trim() : "";
    if (!out) return null;
    return isAbsolute(out) ? out : resolve(dir, out);
  } catch {
    return null;
  }
}

export const approvalPath = (commonDir) => join(commonDir, "maple", APPROVAL_FILE);

/** Local migration versions: `supabase/migrations/<digits>_*.sql`. null when the directory cannot be listed. */
export function localMigrationVersions(supabaseDir) {
  try {
    const dir = join(supabaseDir, "migrations");
    const out = [];
    for (const f of readdirSync(dir)) {
      const m = /^(\d+)_.*\.sql$/i.exec(f) || /^(\d+)\.sql$/i.exec(f);
      if (m) out.push(m[1]);
    }
    return out.sort();
  } catch {
    return null;
  }
}

/**
 * Validate a parsed approval object against the current time.
 * @returns {{ ok: true, approval: object } | { ok: false, reason: string }}
 */
export function validateApproval(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "the approval file is not a JSON object" };
  const { projectRef, versions, issuedAt, expiresAt, issuedBy } = raw;
  if (issuedBy !== ISSUER) return { ok: false, reason: `the approval was not issued by the owner CLI (issuedBy=${JSON.stringify(issuedBy)})` };
  if (typeof projectRef !== "string" || !REF_RE.test(projectRef)) return { ok: false, reason: "the approval has no valid projectRef" };
  if (!Array.isArray(versions) || versions.length === 0 || !versions.every((v) => typeof v === "string" && VERSION_RE.test(v))) {
    return { ok: false, reason: "the approval has no valid versions list" };
  }
  const issued = Date.parse(issuedAt);
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return { ok: false, reason: "the approval has unreadable issuedAt/expiresAt" };
  if (expires - issued > MAX_TTL_MINUTES * 60_000) return { ok: false, reason: `the approval's lifetime exceeds ${MAX_TTL_MINUTES} minutes` };
  if (issued > now + 5 * 60_000) return { ok: false, reason: "the approval is dated in the future" };
  if (expires <= now) return { ok: false, reason: `the approval expired at ${expiresAt}` };
  return { ok: true, approval: { projectRef, versions: [...new Set(versions)].sort(), issuedAt, expiresAt, issuedBy } };
}

/** @returns {{ ok: true, approval } | { ok: false, reason, missing?: true }} */
export function readApproval(commonDir, now = Date.now()) {
  if (!commonDir) return { ok: false, reason: "the git directory could not be located, so no approval can be read", missing: true };
  const file = approvalPath(commonDir);
  if (!existsSync(file)) return { ok: false, reason: "no owner approval exists", missing: true };
  let raw;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { return { ok: false, reason: "the approval file is not valid JSON" }; }
  return validateApproval(raw, now);
}

/** Build the approval object (does not write). Throws a usage Error on bad input. */
export function buildApproval({ projectRef, versions, ttlMinutes = DEFAULT_TTL_MINUTES, now = Date.now() }) {
  if (typeof projectRef !== "string" || !REF_RE.test(projectRef)) throw new Error("--project-ref <ref> is required (letters, digits, - and _)");
  if (!Array.isArray(versions) || versions.length === 0) throw new Error("name at least one migration version (14 digits, e.g. 20261004120000)");
  for (const v of versions) if (!VERSION_RE.test(v)) throw new Error(`"${v}" is not a migration version (14 digits, e.g. 20261004120000)`);
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0 || ttlMinutes > MAX_TTL_MINUTES) throw new Error(`--ttl-minutes must be between 1 and ${MAX_TTL_MINUTES}`);
  return {
    projectRef,
    versions: [...new Set(versions)].sort(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMinutes * 60_000).toISOString(),
    issuedBy: ISSUER,
  };
}

/** Atomic write (temp file + rename) of the approval into <commonDir>/maple/. Returns the file path. */
export function writeApproval(commonDir, approval) {
  const dir = join(commonDir, "maple");
  mkdirSync(dir, { recursive: true });
  const file = approvalPath(commonDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(approval, null, 2) + "\n");
  renameSync(tmp, file);
  return file;
}

/** The exact command the owner runs to issue an approval. */
export function approveCommand(scriptPath, projectRef, versions) {
  const vs = versions && versions.length ? versions.join(" ") : "<version>...";
  return `node "${scriptPath}" --project-ref ${projectRef || "<project-ref>"} ${vs}`;
}
