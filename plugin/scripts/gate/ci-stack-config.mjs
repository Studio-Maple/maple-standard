/**
 * ci-stack-config.mjs - the pure half of the isolated heavy-tier Supabase stack (D071): read ci.stack from
 * maple.config.json and derive the throwaway stack's config.toml from the repo's supabase/config.toml.
 *
 * The derived config differs from the repo's in exactly three ways, all computed at run time (so the copy can never drift):
 *   * project_id  -> <dev id>-ci (or ci.stack.projectId): containers, network and volumes are all named after it
 *   * every port  -> a slot of the CI block portBase..portBase+9 (role-stable: shadow +0, api +1, db +2, studio +3,
 *                    smtp +4, analytics +7, inspector +8, pooler +9, anything else takes a free slot)
 *   * [auth.external.*] enabled -> false: the stack needs no OAuth credentials, so none are read
 * Nothing here touches Docker or the filesystem except readCiStackConfig.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A guard refused: exit 2, nothing was started or removed. */
export class RefusalError extends Error {}

export const DEFAULT_EXCLUDE = ["studio", "imgproxy", "logflare", "vector", "mailpit"];
export const BLOCK_SIZE = 10;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
/** Role -> slot in the CI block. Keys are `<section>.<key>`; others fill the free slots in file order. */
const SLOT_BY_ROLE = { "db.shadow_port": 0, "api.port": 1, "db.port": 2, "studio.port": 3, "local_smtp.port": 4, "inbucket.port": 4, "analytics.port": 7, "edge_runtime.inspector_port": 8, "db.pooler.port": 9 };

const SECTION_RE = /^\s*\[\[?\s*([^\]\s]+)\s*\]\]?\s*(?:#.*)?$/;
const PROJECT_ID_RE = /^(\s*project_id\s*=\s*)"([^"]*)"(.*)$/;
const PORT_RE = /^(\s*)((?:[a-z0-9]+_)*port)(\s*=\s*)(\d+)(\s*(?:#.*)?)$/;
const ENABLED_RE = /^(\s*enabled\s*=\s*)true(\s*(?:#.*)?)$/;
const SITE_URL_RE = /^\s*site_url\s*=\s*"([^"]*)"/;
const isComment = (line) => /^\s*#/.test(line);
const sectionAfter = (line, current) => SECTION_RE.exec(line)?.[1] ?? current;

/** The first top-level project_id of a config.toml, or null. */
export function topLevelProjectId(toml) {
  let section = "";
  for (const line of toml.split(/\r?\n/)) {
    section = sectionAfter(line, section);
    if (section !== "" || isComment(line)) continue;
    const m = PROJECT_ID_RE.exec(line);
    if (m) return m[2];
  }
  return null;
}

/** ci.stack of maple.config.json -> {projectId, portBase, exclude} (projectId defaulted from the dev config), or null when not configured. */
export function readCiStackConfig(root) {
  let cfg = null;
  try {
    cfg = JSON.parse(readFileSync(join(root, "maple.config.json"), "utf8"))?.ci?.stack ?? null;
  } catch {
    return null;
  }
  if (cfg === null) return null;
  const portBase = cfg.portBase;
  if (!Number.isInteger(portBase) || portBase < 1024 || portBase > 65526) throw new RefusalError("maple.config.json ci.stack.portBase must be an integer 1024-65526");
  const toml = join(root, "supabase", "config.toml");
  const devId = existsSync(toml) ? topLevelProjectId(readFileSync(toml, "utf8")) : null;
  const projectId = cfg.projectId ?? (devId ? `${devId}-ci` : null);
  if (!projectId || !ID_RE.test(projectId)) throw new RefusalError(`ci.stack project id ${JSON.stringify(projectId)} is not usable (set ci.stack.projectId)`);
  return { projectId, portBase, exclude: Array.isArray(cfg.exclude) ? cfg.exclude : DEFAULT_EXCLUDE };
}

function rewriteLine(line, section, ctx) {
  if (isComment(line)) return line;
  const id = section === "" ? PROJECT_ID_RE.exec(line) : null;
  if (id && ctx.sourceId === null) {
    ctx.sourceId = id[2];
    return `${id[1]}"${ctx.projectId}"${id[3]}`;
  }
  const port = PORT_RE.exec(line);
  if (port) {
    const role = `${section}.${port[2]}`;
    const original = Number(port[4]);
    ctx.ports.push({ role, original, index: ctx.ports.length });
    return `${port[1]}${port[2]}${port[3]}\u0000${ctx.ports.length - 1}\u0000${port[5]}`; // slot assigned once all roles are known
  }
  if (section.startsWith("auth.external.") && ENABLED_RE.test(line)) return line.replace(ENABLED_RE, "$1false$2");
  const site = section === "auth" ? SITE_URL_RE.exec(line) : null;
  if (site) ctx.siteUrl = site[1];
  return line;
}

function assignSlots(ports) {
  const taken = new Set();
  for (const p of ports) {
    const slot = SLOT_BY_ROLE[p.role];
    if (slot !== undefined && !taken.has(slot)) { p.slot = slot; taken.add(slot); }
  }
  let next = 0;
  for (const p of ports) {
    if (p.slot !== undefined) continue;
    while (taken.has(next)) next++;
    if (next >= BLOCK_SIZE) throw new RefusalError(`supabase/config.toml binds more than ${BLOCK_SIZE} ports: the CI block cannot hold them`);
    p.slot = next;
    taken.add(next);
  }
}

const leaks = (text, ports) => {
  const body = text.split(/\r?\n/).filter((l) => !isComment(l));
  return ports.filter((p) => body.some((l) => new RegExp(`(?<![0-9])${p}(?![0-9])`).test(l)));
};

/**
 * The CI stack's config.toml derived from the repo's. Throws RefusalError when the shape is not understood or the
 * result could touch the dev stack (same project id, any shared port, a dev port still named in the text).
 */
export function deriveCiConfig(toml, { projectId, portBase }) {
  const ctx = { projectId, sourceId: null, ports: [], siteUrl: null };
  const eol = toml.includes("\r\n") ? "\r\n" : "\n";
  let section = "";
  const lines = toml.split(/\r?\n/).map((line) => {
    section = sectionAfter(line, section);
    return rewriteLine(line, section, ctx);
  });
  if (ctx.sourceId === null) throw new RefusalError("supabase/config.toml has no top-level project_id");
  if (ctx.sourceId === projectId) throw new RefusalError(`the CI project id "${projectId}" equals the dev project_id: refusing to touch the dev stack`);
  for (const key of ["api.port", "db.port"]) if (!ctx.ports.some((p) => p.role === key)) throw new RefusalError(`supabase/config.toml has no ${key}: refusing to guess the stack's ports`);
  assignSlots(ctx.ports);
  const devPorts = ctx.ports.map((p) => p.original);
  const ciPorts = ctx.ports.map((p) => portBase + p.slot);
  const shared = ciPorts.filter((p) => devPorts.includes(p));
  if (shared.length) throw new RefusalError(`the CI port block ${portBase}-${portBase + BLOCK_SIZE - 1} overlaps the dev stack's port(s) ${[...new Set(shared)].join(", ")}`);
  const text = lines.join(eol).replace(/\u0000(\d+)\u0000/g, (_, i) => String(ciPorts[Number(i)]));
  const leaked = leaks(text, devPorts);
  if (leaked.length) throw new RefusalError(`the derived config still names the dev stack's port(s) ${leaked.join(", ")}`);
  const at = (role) => ctx.ports.find((p) => p.role === role);
  const port = (role) => (at(role) ? portBase + at(role).slot : undefined);
  return {
    toml: text,
    projectId,
    sourceProjectId: ctx.sourceId,
    siteUrl: ctx.siteUrl,
    devPorts,
    ports: { api: port("api.port"), db: port("db.port"), shadow: port("db.shadow_port"), studio: port("studio.port"), all: ciPorts },
  };
}

/** Refuse unless the config.toml text belongs to the CI project (re-checked before EVERY CLI call). */
export function assertCiConfig(toml, projectId) {
  const id = topLevelProjectId(toml);
  if (id !== projectId) throw new RefusalError(`the CI workdir's config.toml has project_id ${JSON.stringify(id)}, expected "${projectId}"`);
}
