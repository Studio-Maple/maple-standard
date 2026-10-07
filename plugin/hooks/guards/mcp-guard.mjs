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

import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// D067: the Supabase connector's token lists only its default organization, so list_projects /
// list_organizations return a PARTIAL picture (one org) while get_project etc. still reach projects in the
// other orgs by ref. Sessions kept concluding "the connection only has one project". The listing is
// answered with what it cannot show: this repo's refs and how to reach any project directly.
const LISTING = new Set(["list_projects", "list_organizations"]);
const OTHER_PLATFORM_ARGS = ["teamId", "team_id", "accountId", "account_id", "workspace", "workspaceId"];

function isSupabaseListing(t, input) {
  if (!LISTING.has(t.tool)) return false;
  if (/supabase/i.test(t.server)) return true;
  if (t.tool === "list_organizations") return true;
  // another platform's list_projects (e.g. Vercel) takes a team/account scope; Supabase's takes none
  return !OTHER_PLATFORM_ARGS.some((k) => Object.hasOwn(input, k));
}

function knownRefs(ctx) {
  const { root, cfg } = ctx.config();
  const supa = cfg?.supabase ?? {};
  const refs = [];
  for (const r of supa.prodProjectRefs ?? []) refs.push(`${r} (production)`);
  for (const r of supa.devProjectRefs ?? []) refs.push(`${r} (development)`);
  const base = root || ctx.cwd;
  if (base) {
    try {
      const linked = readFileSync(join(base, "supabase", ".temp", "project-ref"), "utf8").trim();
      if (/^[a-z]{20}$/.test(linked) && !refs.some((x) => x.startsWith(linked))) refs.push(`${linked} (linked via supabase link)`);
    } catch { /* not linked */ }
  }
  return refs;
}

export function check(ctx) {
  const t = parseTool(ctx.tool);
  if (t && isSupabaseListing(t, ctx.input)) {
    const refs = knownRefs(ctx);
    return {
      deny:
        `NOTE (supabase-mcp-guard, D067): ${t.tool} is not used - the Supabase connector's token lists only ONE organization, so the result would look like "only that org's projects exist". ` +
        "Projects in the user's other organizations ARE reachable: call get_project / list_tables / execute_sql (read-only) with the project ref directly. " +
        (refs.length
          ? `This repo's Supabase project ref(s): ${refs.join(", ")}.`
          : "This repo lists no Supabase project ref: find it in supabase/.temp/project-ref, the repo docs, or maple.config.json supabase.prodProjectRefs/devProjectRefs, or ask the owner."),
    };
  }
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
