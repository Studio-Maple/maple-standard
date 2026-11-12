// Guard: migrations reach a PRODUCTION Supabase database only when the owner approved those exact versions.
//
// Why: 2026-10-04 a cloud agent ran a raw `supabase db push` against a prod project and applied 11 unapproved
// migrations. deploy-guard's stamp proves the gate passed for HEAD; it says nothing about WHICH migrations ship.
// This guard adds the missing owner decision, enforced inside the PreToolUse dispatcher (Bash, PowerShell, Write,
// Edit, MultiEdit):
//
//  1. Triggers (per parsed segment, through npx / pnpm dlx / bunx / yarn / `bash -c` wrappers):
//     `supabase db push`, `migration up`, `migration repair`, and `db reset` used remotely.
//  2. Target: --db-url (anything but localhost / 127.0.0.1 / [::1] / host.docker.internal), --project-ref, or
//     --linked / the CLI default (db push and migration repair default to the linked project; migration up and
//     db reset default to LOCAL) is PROD unless the ref is in supabase.devProjectRefs and not in
//     supabase.prodProjectRefs. Unknown or unresolvable => PROD (fail closed). --local and --dry-run pass.
//  3. Approval: <git-common-dir>/maple/prod-migration-approval.json, issued only by the owner's CLI
//     (plugin/scripts/predeploy/approve-prod-migration.mjs). Must be unexpired, match the project ref, and cover
//     every version the call would apply (db push / migration up: every local migration >= min(approved) must be
//     approved, --include-all / --include-seed refused; migration repair: every named version approved;
//     db reset on a prod target: always refused).
//  4. The approval file and the issuing script are untouchable by tool calls.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectableArgs, isDataOnly, gitInfo, parseShell } from "./shell.mjs";
import { approveCommand, gitCommonDir, localMigrationVersions, readApproval } from "../../scripts/predeploy/migration-approval.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const APPROVE_SCRIPT = join(HERE, "..", "..", "scripts", "predeploy", "approve-prod-migration.mjs");

const RUNNERS = new Set(["npx", "pnpm", "pnpx", "bunx", "bun", "yarn", "npm", "corepack", "node", "deno", "volta", "mise"]);
const PKG_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "pwsh", "powershell", "cmd"]);
const SHELL_CMD_FLAGS = /^(-c|-command|-encodedcommand|\/c|-lc|-ec)$/i;
const VALUE_FLAGS = new Set([
  "--workdir", "--profile", "-o", "--output", "--dns-resolver", "--network-id", "--agent",
  "--db-url", "--project-ref", "-p", "--password", "--status", "--last", "--version", "-s", "--schema",
]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "host.docker.internal"]);

// Read-only verbs: naming the approval file / script is fine for them unless they redirect or edit in place.
const READERS = new Set([
  "cat", "ls", "dir", "type", "head", "tail", "grep", "egrep", "rg", "get-content", "select-string", "gc", "sls", "wc", "findstr",
  "stat", "test", "[", "file", "less", "more", "diff", "get-childitem", "gci", "test-path", "get-item",
]);
const GIT_NONWRITE = new Set(["add", "diff", "log", "show", "status", "blame", "ls-files", "restore", "checkout", "stash", "commit", "grep", "check-ignore", "rev-parse"]);
const APPROVAL_RE = /prod-migration-(approval|\*|\?|\[)|maple[\\/]prod-/i;
const SCRIPT_RE = /approve-prod-migration/i;
const SCRIPT_WRAPPER_RE = /^(db-push|apply-migrations)(\.(sh|bash|ps1))?$/i;

const baseOf = (t) => String(t).replace(/\\/g, "/").split("/").pop().replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();

// ---------------------------------------------------------------------------------------------- protection

function readOnly(seg) {
  if (seg.words.some((w) => w.redir)) return false;
  if (READERS.has(seg.verb)) return true;
  const g = gitInfo(seg);
  return Boolean(g && GIT_NONWRITE.has(g.sub));
}

/** Tool call touching the approval file or running the issuing script. @returns deny message or undefined */
function protectedTouch(ctx) {
  const { tool, input } = ctx;
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) {
    const file = String(input.file_path || input.path || input.notebook_path || "");
    if (file && APPROVAL_RE.test(file.replace(/\\/g, "/"))) return deniedTamper();
    return undefined;
  }
  for (const seg of ctx.segments()) {
    const dataOnly = isDataOnly(seg);
    const words = dataOnly ? seg.words.filter((w) => w.redir) : inspectableArgs(seg, { includeRedir: true });
    const texts = [seg.verb, ...words.map((w) => w.text)];
    if (texts.some((t) => SCRIPT_RE.test(t)) && !dataOnly && !readOnly(seg)) return deniedScript();
    if (texts.some((t) => APPROVAL_RE.test(t)) && !readOnly(seg)) return deniedTamper();
    if (/^(sed|perl)$/.test(seg.verb) && texts.some((t) => APPROVAL_RE.test(t))) return deniedTamper();
  }
  return undefined;
}

const deniedTamper = () =>
  "BLOCKED (prod-migration-guard): the production-migration approval (.git/maple/prod-migration-approval*) is written only by the owner's CLI; " +
  "tool calls cannot create, edit, move or delete it.";
const deniedScript = () =>
  "BLOCKED (prod-migration-guard): approve-prod-migration.mjs issues the owner's approval for production migrations; it is run only by the owner in his own terminal, " +
  "never by an agent. Ask the owner to run the approval command.";

// ---------------------------------------------------------------------------------------------- parsing

/** Supabase invocations found in the segments (wrappers unwrapped). @returns {{ args: {text:string, sub:boolean}[], seg }[]} */
export function supabaseCalls(segments, shell = "bash", depth = 0, cwd = process.cwd()) {
  const calls = [];
  for (const seg of segments) {
    if (isDataOnly(seg) || READERS.has(seg.verb)) continue;
    // `$VAR` / `$(...)` and PowerShell splatting (`@args`) hide words from us: mark them unclear
    const view = (ws) => ws.map((w) => ({ text: w.text, sub: Boolean(w.sub) || /\$/.test(w.text) || (/^p/i.test(shell) && !w.quoted && w.text.startsWith("@") && w.text.length > 1) }));
    if (seg.verb === "supabase") { calls.push({ args: view(seg.args), seg }); continue; }
    if (RUNNERS.has(seg.verb)) {
      const idx = seg.args.findIndex((w) => /^supabase(@.+)?$/.test(baseOf(w.text)));
      if (idx >= 0) { calls.push({ args: view(seg.args.slice(idx + 1)), seg }); continue; }
      if (depth < 4 && PKG_RUNNERS.has(seg.verb)) {
        const body = packageScript(seg, cwd);
        if (body) {
          const inner = supabaseCalls(parseShell(body.text, shell), shell, depth + 1, body.dir);
          if (inner.length && body.extra.length) {
            const last = inner[inner.length - 1];
            last.args = [...last.args, ...body.extra.map((t) => ({ text: t, sub: /\$/.test(t) }))];
          }
          for (const c of inner) calls.push({ ...c, seg });
        }
      }
    }
    if (depth < 3 && (SHELLS.has(seg.verb) || seg.verb === "eval")) {
      const ps = /^(pwsh|powershell|cmd)$/.test(seg.verb) ? "powershell" : "bash";
      let inner = "";
      if (seg.verb === "eval") inner = seg.args.map((w) => w.text).join(" ");
      else {
        const i = seg.args.findIndex((w) => SHELL_CMD_FLAGS.test(w.text));
        if (i >= 0) inner = seg.args.slice(i + 1).map((w) => w.text).join(" ");
      }
      if (inner) {
        for (const c of supabaseCalls(parseShell(inner, ps), ps, depth + 1, cwd)) calls.push({ ...c, seg });
      }
    }
    // Migration wrapper scripts (db-push.sh, apply-migrations.sh): run directly or through a shell. The target cannot be
    // read out of the script, so it is judged as a default `db push` (linked project) plus whatever flags follow the script name.
    const ins = inspectableArgs(seg);
    const scriptAt = SCRIPT_WRAPPER_RE.test(baseOf(seg.verb)) ? -1 : ins.findIndex((w) => SCRIPT_WRAPPER_RE.test(baseOf(w.text)));
    if (SCRIPT_WRAPPER_RE.test(baseOf(seg.verb)) || (scriptAt >= 0 && (SHELLS.has(seg.verb) || seg.verb === "source" || seg.verb === "."))) {
      calls.push({ args: [{ text: "db", sub: false }, { text: "push", sub: false }, ...view(ins.slice(scriptAt + 1))], seg });
    }
    // Generic wrapper rule (`npm run sb -- db push`, `node scripts/sb.mjs db push`, ...): the subcommand tokens appear in a
    // CLI invocation whose binary is not supabase itself. The tokens after the group are parsed like a supabase call.
    if (seg.verb !== "git" && seg.verb !== "supabase" && !ins.some((w) => /^prisma(@.+)?$/.test(baseOf(w.text)))) {
      for (let k = 0; k + 1 < ins.length; k++) {
        const grp = ins[k].text.toLowerCase();
        const sub = ins[k + 1].text.toLowerCase();
        if ((grp === "db" && (sub === "push" || sub === "reset")) || (/^migrations?$/.test(grp) && (sub === "up" || sub === "repair"))) {
          calls.push({ args: view(ins.slice(k)), seg });
          break;
        }
      }
    }
  }
  return calls;
}

/** `npm|pnpm|yarn|bun [run|run-script] <name> [-- extra]` -> the package.json script body it runs (nearest package.json). */
function packageScript(seg, cwd) {
  const a = seg.args.map((w) => w.text);
  let i = a.findIndex((t) => !t.startsWith("-"));
  if (i < 0) return null;
  if (a[i] === "run" || a[i] === "run-script") i = a.findIndex((t, k) => k > i && !t.startsWith("-"));
  else if (seg.verb === "npm") return null; // npm needs `run` for custom scripts
  if (i < 0) return null;
  const name = a[i];
  let dir = seg.cd ? resolve(cwd, seg.cd) : resolve(cwd);
  for (;;) {
    const file = join(dir, "package.json");
    if (existsSync(file)) {
      try {
        const scripts = JSON.parse(readFileSync(file, "utf8")).scripts;
        const text = scripts && Object.hasOwn(scripts, name) ? scripts[name] : null;
        if (typeof text === "string") return { text, dir, extra: a.slice(i + 1).filter((t) => t !== "--") };
      } catch { /* unreadable package.json: treat as no script */ }
      return null;
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** True when this segment may change which project is linked (`supabase link|unlink`, a write to .temp/project-ref). */
function relinks(seg) {
  const texts = [seg.verb, ...inspectableArgs(seg, { includeRedir: true }).map((w) => w.text)];
  if (texts.some((t) => /\.temp[\/]project-ref/i.test(t)) && !(READERS.has(seg.verb) && !seg.words.some((w) => w.redir))) return true;
  return supabaseCalls([seg], "bash", 0, process.cwd()).some((c) => /^(link|unlink|init)$/.test(parseSupabaseArgs(c.args).group ?? ""));
}

/** @returns {{ group, sub, positionals: string[], flags: Map<string,string|true>, unclear: boolean }} */
export function parseSupabaseArgs(args) {
  const flags = new Map();
  const positionals = [];
  let unclear = false;
  for (let n = 0; n < args.length; n++) {
    const { text, sub } = args[n];
    if (text.startsWith("-") && text.length > 1) {
      const eq = text.indexOf("=");
      const name = (eq < 0 ? text : text.slice(0, eq)).toLowerCase();
      if (eq >= 0) { flags.set(name, text.slice(eq + 1)); if (sub) unclear = true; }
      else if (VALUE_FLAGS.has(name)) { const v = args[++n]; flags.set(name, v ? v.text : ""); if (v?.sub) flags.set(`${name}#unclear`, true); }
      else flags.set(name, true);
      continue;
    }
    if (sub) unclear = true;
    positionals.push(text);
  }
  return { group: positionals[0]?.toLowerCase(), sub: positionals[1]?.toLowerCase(), positionals, flags, unclear };
}

/** host of a libpq URL; null when it cannot be read safely. Rejects `?host=` / `hostaddr=` overrides. */
export function dbUrlHost(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^#]*)/i.exec(String(url).trim());
  if (!m) return null;
  if (/[?&](host|hostaddr|service)=/i.test(m[2])) return null;
  const authority = m[1].slice(m[1].lastIndexOf("@") + 1);
  const host = authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0];
  return host ? host.toLowerCase() : null;
}

/** Project ref a Supabase-hosted --db-url names (db.<ref>.supabase.co, or user postgres.<ref> on a supabase pooler host). */
export function dbUrlRef(url) {
  const host = dbUrlHost(url);
  if (!host || !/\.supabase\.(co|com)$/.test(host)) return undefined;
  const h = /^db\.([a-z0-9]+)\.supabase\.(?:co|com)$/.exec(host);
  if (h) return h[1];
  const u = /^[a-z][a-z0-9+.-]*:\/\/postgres\.([a-z0-9]+)(?::[^@]*)?@/i.exec(String(url).trim());
  return u && /\.pooler\.supabase\.(co|com)$/.test(host) ? u[1].toLowerCase() : undefined;
}

function findSupabaseDir(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "supabase", "config.toml")) || existsSync(join(dir, "supabase", "migrations"))) return join(dir, "supabase");
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function linkedRef(supabaseDir) {
  if (!supabaseDir) return undefined;
  try {
    const ref = readFileSync(join(supabaseDir, ".temp", "project-ref"), "utf8").trim();
    return /^[a-z0-9]{6,64}$/i.test(ref) ? ref : undefined;
  } catch { return undefined; }
}

// ---------------------------------------------------------------------------------------------- decision

function refLists(ctx) {
  const supa = ctx.config().cfg?.supabase ?? {};
  return {
    dev: Array.isArray(supa.devProjectRefs) ? supa.devProjectRefs : [],
    prod: Array.isArray(supa.prodProjectRefs) ? supa.prodProjectRefs : [],
  };
}

/** A ref is safe (DEV) only when listed as dev and not also listed as prod. Everything else is prod. */
const isDev = (lists, ref) => Boolean(ref) && lists.dev.includes(ref) && !lists.prod.includes(ref);

/**
 * Production targets of one supabase call. Empty array = the call is local / dev / dry-run (allowed).
 * @returns {{ kind, prodTargets: {ref?: string, via: string}[], parsed, supabaseDir }|null} null = not a trigger
 */
export function classify(call, ctx) {
  const p = parseSupabaseArgs(call.args);
  const key = `${p.group}/${p.sub}`;
  const kinds = { "db/push": "push", "migration/up": "up", "migration/repair": "repair", "migrations/up": "up", "migrations/repair": "repair", "db/reset": "reset" };
  const kind = kinds[key];
  if (!kind) return null;
  const f = p.flags;
  const lists = refLists(ctx);
  const base = call.seg.cd ? resolve(ctx.cwd, call.seg.cd) : ctx.cwd;
  const workdir = typeof f.get("--workdir") === "string" && f.get("--workdir") ? resolve(base, f.get("--workdir")) : base;
  const supabaseDir = findSupabaseDir(workdir);
  const out = { kind, prodTargets: [], parsed: p, supabaseDir, base: workdir };
  if (kind === "push" && f.has("--dry-run")) return out;

  const remote = [];
  if (f.has("--db-url")) remote.push("db-url");
  if (f.has("--project-ref")) remote.push("project-ref");
  if (f.has("--linked")) remote.push("linked");
  if (!remote.length && !f.has("--local") && (kind === "push" || kind === "repair")) remote.push("linked"); // CLI default
  if (!remote.length && p.unclear) remote.push("unresolved");

  for (const via of remote) {
    if (via === "db-url") {
      const url = String(f.get("--db-url"));
      if (f.get("--db-url#unclear") || /\$/.test(url)) { out.prodTargets.push({ via: "--db-url (unresolved variable)" }); continue; }
      const host = dbUrlHost(url);
      if (host && LOCAL_HOSTS.has(host)) continue;
      const ref = dbUrlRef(url);
      if (isDev(lists, ref)) continue;
      out.prodTargets.push({ ref, via: `--db-url (${host ?? "unreadable url"})` });
    } else if (via === "project-ref") {
      const ref = String(f.get("--project-ref"));
      if (f.get("--project-ref#unclear") || /\$/.test(ref) || !ref) { out.prodTargets.push({ via: "--project-ref (unresolved)" }); continue; }
      if (!isDev(lists, ref)) out.prodTargets.push({ ref, via: "--project-ref" });
    } else if (via === "linked") {
      if (call.relinked) { out.prodTargets.push({ via: "the linked project, which an earlier part of this same command may re-link" }); continue; }
      const ref = linkedRef(supabaseDir);
      if (!isDev(lists, ref)) out.prodTargets.push({ ref, via: ref ? "the linked project" : "the linked project (supabase/.temp/project-ref missing or unreadable)" });
    } else {
      out.prodTargets.push({ via: "an unresolved argument" });
    }
  }
  return out;
}

function approvalHint(ref, versions) {
  return `Owner: run this in your own terminal, then retry:\n  ${approveCommand(APPROVE_SCRIPT, ref, versions)} [--ttl-minutes 30]`;
}
const blocked = (what, hint) => ({ deny: `BLOCKED (prod-migration-guard): ${what}\n${hint}` });

/** Decide one classified production call. @returns {{deny}|undefined} */
function decide(c, ctx) {
  const { kind, parsed, supabaseDir } = c;
  const f = parsed.flags;
  const refs = c.prodTargets.map((t) => t.ref);
  const where = c.prodTargets.map((t) => `${t.ref ?? "unknown project"} via ${t.via}`).join("; ");
  const verb = { push: "supabase db push", up: "supabase migration up", repair: "supabase migration repair", reset: "supabase db reset" }[kind];

  if (kind === "reset") {
    return blocked(`${verb} would WIPE a production database (${where}). No approval covers a remote reset.`,
      "Reset only the local stack (`supabase db reset` without --linked / --db-url). To change prod, ship a new migration.");
  }
  if (f.has("--include-all")) {
    return blocked(`${verb} --include-all against production (${where}) applies every migration missing from the remote history, approved or not.`,
      "Drop --include-all; prod applies pending migrations in order, and every one must be owner-approved.");
  }
  if (f.has("--include-seed") || f.has("--include-roles")) {
    return blocked(`${verb} with --include-seed/--include-roles against production (${where}) runs seed data / roles on prod, which no approval covers.`,
      "Drop the flag; seed and roles are never approved for production.");
  }
  const unknown = c.prodTargets.find((t) => !t.ref);
  if (unknown) {
    return blocked(`${verb} targets production but its project ref cannot be determined (${where}); an approval can only be matched to a known ref.`,
      "Run `supabase link --project-ref <ref>` (it writes supabase/.temp/project-ref) or pass a literal --project-ref; do not use shell variables for the target.");
  }

  const versions = kind === "repair" ? parsed.positionals.slice(2) : [];
  if (kind === "repair" && versions.length === 0) {
    return blocked(`${verb} against production (${where}) names no migration version, so nothing can be matched to an approval.`, approvalHint(refs[0], []));
  }
  for (const target of c.prodTargets) {
    const a = readApproval(gitCommonDir(c.base));
    if (!a.ok) {
      return blocked(`${verb} against production project ${target.ref} refused: ${a.reason}.`, approvalHint(target.ref, versions));
    }
    const ap = a.approval;
    if (ap.projectRef !== target.ref) {
      return blocked(`${verb} targets production project ${target.ref}, but the owner's approval is for ${ap.projectRef}.`, approvalHint(target.ref, versions));
    }
    if (kind === "repair") {
      const missing = versions.filter((v) => !ap.versions.includes(v));
      if (missing.length) {
        return blocked(`${verb} names version(s) the owner has not approved for ${target.ref}: ${missing.join(", ")}. Approved: ${ap.versions.join(", ")}.`,
          approvalHint(target.ref, [...new Set([...ap.versions, ...missing])].sort()));
      }
      continue;
    }
    const local = localMigrationVersions(supabaseDir ?? "");
    if (!local) {
      return blocked(`${verb} against production refused: supabase/migrations could not be listed, so the pending files cannot be checked against the approval.`,
        "Run it from the project (or pass --workdir) so supabase/migrations is readable.");
    }
    const min = ap.versions[0];
    const pending = local.filter((v) => v >= min && !ap.versions.includes(v));
    if (pending.length) {
      return blocked(`${verb} against production project ${target.ref} would also apply migration(s) the owner has not approved: ${pending.join(", ")}. ` +
        `Prod applies in order, so every local migration at or after ${min} must be approved. Approved: ${ap.versions.join(", ")}.`,
        approvalHint(target.ref, [...new Set([...ap.versions, ...pending])].sort()) +
        "\n  (List what is really pending on prod with `supabase migration list --linked`; the approval must name ALL of it. Or remove/rename the unapproved local files.)");
    }
  }
  return undefined;
}

export function check(ctx) {
  const touched = protectedTouch(ctx);
  if (touched) return { deny: touched };
  if (ctx.tool !== "Bash" && ctx.tool !== "PowerShell") return undefined;
  if (!ctx.command) return undefined;
  let relinked = false;
  for (const seg of ctx.segments()) {
    for (const call of supabaseCalls([seg], ctx.shell, 0, ctx.cwd)) {
      const c = classify({ ...call, relinked }, ctx);
      if (!c || c.prodTargets.length === 0) continue;
      const res = decide(c, ctx);
      if (res) return res;
    }
    if (relinks(seg)) relinked = true;
  }
  return undefined;
}

/** Dispatcher fallback on internal error / deadline: deny only when the command looks like a migration trigger. */
export function failClosed(ctx, why) {
  if ((ctx.tool === "Bash" || ctx.tool === "PowerShell") && /supabase/i.test(ctx.command) && /\b(db\s+(push|reset)|migrations?\s+(up|repair))\b/i.test(ctx.command)) {
    return { deny: `BLOCKED (prod-migration-guard): ${why} while checking a Supabase migration command. Failing closed.` };
  }
  return undefined;
}
