/**
 * ci-stack-env.mjs - the recorded environment of a running CI stack and its output formats (D071).
 * SECRET-BEARING (anon/service keys): produced for `eval "$(node ci-stack.mjs env)"` and never passed to a logger.
 */
import { RefusalError } from "./ci-stack-config.mjs";

/** Parse `supabase status -o env` (KEY="value" lines). */
export function parseEnvOutput(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(?:"(.*)"|(.*))$/.exec(line.trim());
    if (m) out[m[1]] = m[2] ?? m[3] ?? "";
  }
  return out;
}

const portOf = (url) => {
  try { return new URL(url).port; } catch { return ""; }
};

/** What `supabase status` says about the CI stack, refused unless it really is on the CI ports (the CLI must be talking to the CI project). */
export function ciEnvFromStatus(status, derived, workdir) {
  const apiPort = derived.ports.api;
  const dbPort = derived.ports.db;
  if (portOf(status.API_URL) !== String(apiPort)) throw new RefusalError(`supabase status reports API_URL ${status.API_URL ?? "(none)"} but the CI API is on :${apiPort}: the CLI is not talking to ${derived.projectId}`);
  if (status.DB_URL && portOf(status.DB_URL) !== String(dbPort)) throw new RefusalError(`supabase status reports DB_URL on :${portOf(status.DB_URL)} but the CI database is on :${dbPort}`);
  if (!status.ANON_KEY) throw new Error("supabase status printed no ANON_KEY");
  return {
    projectId: derived.projectId,
    apiPort,
    dbPort,
    workdir,
    apiUrl: `http://127.0.0.1:${apiPort}`,
    dbUrl: status.DB_URL || `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`,
    anonKey: status.ANON_KEY,
    serviceRoleKey: status.SERVICE_ROLE_KEY ?? "",
  };
}

/** The variables tests need, by the names the template's suites read (supabase/tests/local-defaults.mjs: SUPABASE_URL, SUPABASE_ANON_KEY). */
export function stackEnvVars(env) {
  return {
    SUPABASE_URL: env.apiUrl,
    SUPABASE_ANON_KEY: env.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: env.serviceRoleKey,
    SUPABASE_DB_URL: env.dbUrl,
    E2E_SUPABASE_URL: env.apiUrl,
    E2E_SUPABASE_ANON_KEY: env.anonKey,
    CI_SUPABASE_PROJECT_ID: env.projectId,
    CI_SUPABASE_WORKDIR: env.workdir,
  };
}

const shq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

/** sh: `export K='v'` lines (eval-able); dotenv: K="v"; json: one object. Empty values are skipped. */
export function formatEnv(vars, format = "sh") {
  const entries = Object.entries(vars).filter(([, v]) => v !== "" && v !== undefined);
  if (format === "json") return `${JSON.stringify(Object.fromEntries(entries))}\n`;
  if (format === "dotenv") return entries.map(([k, v]) => `${k}="${String(v).replace(/(["\\])/g, "\\$1")}"\n`).join("");
  if (format === "sh") return entries.map(([k, v]) => `export ${k}=${shq(v)}\n`).join("");
  throw new RefusalError(`unknown env format "${format}" (sh | json | dotenv)`);
}
