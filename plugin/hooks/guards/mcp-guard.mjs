// Guard: mutating Supabase MCP tools against anything but a listed DEV project (D065).
//
// The Supabase MCP server can apply migrations, run SQL and deploy functions against production with
// no git, gate or stamp in the way. Mutating tools are denied unless tool_input.project_id is listed in
// maple.config.json supabase.devProjectRefs (and not in supabase.prodProjectRefs). Unknown ref => deny.
// Read-only tools (list_*, get_*, query_logs, search_docs, ...) are never touched; execute_sql passes
// when the SQL is provably read-only (a single select/with/explain/show statement, no write keywords).
//
// Applies to any server whose name contains "supabase", and to any server's tool of these names that
// carries a `project_id` (MCP server names are arbitrary, e.g. a uuid for a connector).

const MUTATING = new Set([
  "apply_migration", "execute_sql", "deploy_edge_function", "merge_branch", "reset_branch", "rebase_branch",
  "delete_branch", "pause_project", "restore_project",
]);
const READ_START = /^(select|with|explain|show)\b/i;
const WRITE_WORDS = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|call|do|copy|vacuum|reindex|refresh|comment|lock|notify|listen|into|analyze|nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|lo_import|lo_export|dblink|pg_sleep)\b/i;

/** Remove comments and string/quoted-identifier literals so keywords inside them are not judged. */
function stripSqlNoise(sql) {
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
  s = s.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''").replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
  return s;
}

/** True only for a single statement that starts with select/with/explain/show and contains no write keyword. */
export function isReadOnlySql(sql) {
  if (typeof sql !== "string") return false;
  const s = stripSqlNoise(sql).trim().replace(/;\s*$/, "").trim();
  if (!s || s.includes(";")) return false;
  return READ_START.test(s) && !WRITE_WORDS.test(s);
}

function parseTool(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || "");
  return m ? { server: m[1], tool: m[2] } : null;
}

export function check(ctx) {
  const t = parseTool(ctx.tool);
  if (!t || !MUTATING.has(t.tool)) return undefined;
  const input = ctx.input;
  const hasRef = Object.hasOwn(input, "project_id");
  if (!/supabase/i.test(t.server) && !hasRef) return undefined; // not a Supabase-shaped call
  if (t.tool === "execute_sql" && isReadOnlySql(input.query ?? input.sql)) return undefined;

  const supa = ctx.config().cfg?.supabase ?? {};
  const dev = Array.isArray(supa.devProjectRefs) ? supa.devProjectRefs : [];
  const prod = Array.isArray(supa.prodProjectRefs) ? supa.prodProjectRefs : [];
  const ref = typeof input.project_id === "string" ? input.project_id : "";
  if (ref && prod.includes(ref)) {
    return { deny: `BLOCKED (supabase-mcp-guard): ${t.tool} targets PRODUCTION project ${ref} (supabase.prodProjectRefs). Production schema changes ship as migrations through git and the pre-deploy gate (D060), never through the MCP server.` };
  }
  if (ref && dev.includes(ref)) return undefined;
  return {
    deny:
      `BLOCKED (supabase-mcp-guard): ${t.tool} on ${ref ? `project ${ref}` : "an unspecified project"} — that ref is not a listed DEV project, so it is treated as production. ` +
      "If it is a development project, the owner lists its ref in maple.config.json `supabase.devProjectRefs` (and production refs in `supabase.prodProjectRefs`). " +
      "Production changes ship as migrations through git and the pre-deploy gate (D060).",
  };
}
