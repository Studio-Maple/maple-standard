/**
 * credentials.mjs — just-in-time secret lookup for gate checks that need an
 * API token or a scan auth header (Supabase management token, Cloudflare
 * Access service token for the live scan).
 *
 * Order: process env `MAPLE_CRED_<TARGET upper-snake>` (CI / tests), then
 * Windows Credential Manager via the CredentialManager PowerShell module
 * (the credential-manager skill's path). Values live only in this process's
 * memory — never written to a report, plan file, log or argv.
 *
 * `credentialExists` answers presence without ever returning the value, so
 * `doctor` can report a missing token BY NAME.
 */
import { spawnSync } from "node:child_process";

export function envNameFor(target) {
  return "MAPLE_CRED_" + String(target).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function psGet(target) {
  if (process.platform !== "win32") return null;
  const script = `Import-Module CredentialManager -ErrorAction Stop; $c = Get-StoredCredential -Target '${String(target).replace(/'/g, "''")}'; if ($c) { [Console]::Out.Write($c.GetNetworkCredential().Password) }`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) return null;
  return r.stdout || null;
}

export function getCredential(target) {
  const fromEnv = process.env[envNameFor(target)];
  if (fromEnv) return fromEnv;
  return psGet(target);
}

/** Presence only — never returns the secret. */
export function credentialExists(target) {
  if (process.env[envNameFor(target)]) return true;
  if (process.platform !== "win32") return false;
  const r = spawnSync("cmdkey", [`/list:${target}`], { encoding: "utf8", timeout: 15000 });
  return r.status === 0 && /Target:/i.test(String(r.stdout)) && !/NONE/i.test(String(r.stdout).split(/\r?\n/).slice(0, 4).join(" "));
}
