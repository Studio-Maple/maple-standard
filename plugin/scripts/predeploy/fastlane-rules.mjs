/**
 * fastlane-rules.mjs - which changes may take the fast lane (deploy first, enforce after).
 *
 * Eligibility is a PROOF FROM THE DIFF between the last fully stamped commit and HEAD: every changed path must
 *   1. match no deny pattern (the built-in baseline below + the project's exception files + `fastLane.deny`), and
 *   2. match at least one `fastLane.allow` pattern.
 * A path that matches neither list is "unclassified" and is NOT eligible: the lane never guesses. Deny always wins, and
 * config can only ADD deny patterns, never remove a baseline one.
 *
 * Glob dialect (case-insensitive, `/` separators): `**` any depth, `*` within one segment, `?` one character,
 * `{a,b}` alternation. A pattern without a `/` matches the file NAME at any depth (`*.sql`, `package.json`).
 */
import { canonicalJson, sha256 } from "./lib.mjs";

export const FAST_LANE_DEFAULTS = { enabled: false, deadlineHours: 12, permitMinutes: 60, gateTiers: ["gate"], allow: [], deny: [] };

/** Built-in deny list. Over-matching is safe here: a denied change simply takes the full path. */
export const BASELINE_DENY = [
  { class: "database migration", globs: ["**/migrations/**", "*.sql", "**/prisma/**", "**/drizzle/**", "**/alembic/**"] },
  {
    class: "infrastructure / deploy",
    globs: ["*.tf", "*.tfvars", "*.hcl", "**/terraform/**", "**/infra/**", "**/deploy/**", "deploy*", "*compose*.yml", "*compose*.yaml", "Dockerfile*", "*.dockerfile", ".dockerignore", "**/k8s/**", "**/helm/**", "wrangler.toml", "wrangler.json*", "vercel.json", "netlify.toml", "fly.toml", "Caddyfile*", "nginx*.conf", "*.service"],
  },
  {
    class: "auth / permissions / RLS",
    globs: ["**/auth/**", "*auth*", "*rls*", "*polic*", "*permission*", "*rbac*", "*jwt*", "*login*", "*password*", "*secret*", "*credential*", "middleware.*", "**/supabase/config.toml"],
  },
  { class: "edge function", globs: ["**/supabase/functions/**", "functions/**", "**/edge-functions/**"] },
  {
    class: "dependency manifest / lockfile",
    globs: ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lock*", ".npmrc", ".yarnrc*", "requirements*.txt", "constraints*.txt", "pyproject.toml", "poetry.lock", "uv.lock", "Pipfile*", "setup.py", "setup.cfg", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "deno.json*", "deno.lock", "import_map.json", "Gemfile*", "composer.json", "composer.lock", "**/vendor/**"],
  },
  {
    class: "CI / gate configuration",
    globs: [".github/**", ".gitlab-ci.yml", ".circleci/**", ".husky/**", ".githooks/**", "lefthook.y*ml", ".pre-commit-config.yaml", "lint-staged.config.*", "maple.config.json", ".claude/**", "ci-local.*", "prepush-lib.sh", "run-gate.*", ".gitleaks.toml", ".gitleaksignore", ".semgrep*", "**/.semgrep/**", ".trivyignore*", ".checkov*", "eslint.config.*", ".eslintrc*", "tsconfig*.json", "vitest.config.*", "jest.config.*", "playwright.config.*", "knip.json*", "predeploy-*.json"],
  },
  { class: "secret / environment file", globs: [".env*", ".dev.vars*", "*.pem", "*.key", "*.p12", "*.pfx"] },
  { class: "git plumbing", globs: [".gitmodules", ".gitattributes"] },
];

/** Per-target modes: `default` = a routine permit suffices, `owner-only` = the permit must record the owner's explicit approval, `off` = no fast lane. */
export const TARGET_MODES = ["default", "owner-only", "off"];
export const PRODUCTION = "production";
export const TARGET_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * The fast-lane mode for a deploy target. `fastLane.targets` absent = the legacy single lane: every target is `default`.
 * With `targets` present, a target that is not listed is `off` (the lane never guesses).
 */
export function modeFor(fl, target) {
  if (!fl?.targets) return "default";
  return fl.targets[target] ?? "off";
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
const posix = (p) => String(p).replace(/\\/g, "/").replace(/^\.\//, "");

/** Compile one glob (see the dialect above) to an anchored, case-insensitive RegExp. Throws on an unbalanced `{`. */
export function globToRegExp(glob) {
  let g = posix(glob).trim();
  if (!g.includes("/")) g = "**/" + g;
  let re = "";
  let depth = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") { depth++; re += "(?:"; }
    else if (c === "}") { if (!depth) throw new Error(`unbalanced "}" in glob "${glob}"`); depth--; re += ")"; }
    else if (c === "," && depth) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  if (depth) throw new Error(`unbalanced "{" in glob "${glob}"`);
  return new RegExp("^" + re + "$", "i");
}

/** The lane's settings for a normalized predeploy block, or null when the project has not switched it on. */
export function normalizeFastLane(pd) {
  const f = pd?.fastLane;
  if (!isObj(f) || f.enabled !== true) return null;
  return { ...FAST_LANE_DEFAULTS, ...f, allow: f.allow || [], deny: f.deny || [], gateTiers: f.gateTiers || FAST_LANE_DEFAULTS.gateTiers };
}

/** Every deny rule in force: baseline, the project's own exception files (exact paths), then `fastLane.deny`. */
export function denyRules(pd, fl) {
  const own = [pd?.allowlist, pd?.decisions, pd?.imageDebt?.file].filter(isStr).map(posix).filter((p) => !/^([A-Za-z]:)?\//.test(p));
  return [
    ...BASELINE_DENY,
    ...(own.length ? [{ class: "gate exception file", globs: own.map((p) => (p.includes("/") ? p : "/" + p)) }] : []),
    ...((fl?.deny || []).length ? [{ class: "project deny list", globs: fl.deny }] : []),
  ];
}

const compile = (glob) => (glob.startsWith("/") ? new RegExp("^" + glob.slice(1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") : globToRegExp(glob));

/**
 * @param {{path:string, special?:string}[]} entries changed paths (`special` = a non-file change such as a submodule pointer)
 * @returns {{eligible:boolean, denied:{path:string, reason:string}[], allowed:string[]}}
 */
export function classify(entries, pd, fl) {
  const deny = denyRules(pd, fl).flatMap((r) => r.globs.map((g) => ({ cls: r.class, glob: g, re: compile(g) })));
  const allow = (fl?.allow || []).map((g) => ({ glob: g, re: globToRegExp(g) }));
  const denied = [];
  const allowed = [];
  for (const e of entries) {
    const p = posix(e.path);
    if (e.special) { denied.push({ path: p, reason: `denied: ${e.special}` }); continue; }
    const d = deny.find((r) => r.re.test(p));
    if (d) { denied.push({ path: p, reason: `denied: ${d.cls} (matches "${d.glob.replace(/^\//, "")}")` }); continue; }
    if (!allow.some((a) => a.re.test(p))) { denied.push({ path: p, reason: "unclassified: matches no fastLane.allow pattern" }); continue; }
    allowed.push(p);
  }
  return { eligible: denied.length === 0, denied, allowed };
}

/** Binds a permit to the rules it was judged under: any change to the lists voids an outstanding permit. */
export function rulesHash(pd, fl) {
  return sha256(canonicalJson({ deny: denyRules(pd, fl), allow: fl?.allow || [], v: 1 }));
}

export function validateFastLane(p) {
  const e = [];
  const f = p?.fastLane;
  if (f === undefined) return e;
  if (!isObj(f)) return ["predeploy.fastLane: must be an object { enabled, allow, deny?, deadlineHours?, permitMinutes?, gateTiers? }"];
  for (const k of Object.keys(f)) if (!["enabled", "allow", "deny", "deadlineHours", "permitMinutes", "gateTiers", "targets"].includes(k)) e.push(`predeploy.fastLane.${k}: unknown key`);
  if (typeof f.enabled !== "boolean") e.push("predeploy.fastLane.enabled: required boolean (the lane is off unless a project switches it on)");
  if (f.deadlineHours !== undefined && !(Number.isInteger(f.deadlineHours) && f.deadlineHours >= 1 && f.deadlineHours <= 48)) e.push("predeploy.fastLane.deadlineHours: integer 1..48 (hours the full heavy + predeploy run may trail a fast deploy; default 12)");
  if (f.permitMinutes !== undefined && !(Number.isInteger(f.permitMinutes) && f.permitMinutes >= 5 && f.permitMinutes <= 240)) e.push("predeploy.fastLane.permitMinutes: integer 5..240 (how long a permit, and a multi-step deploy under it, stays open; default 60)");
  if (f.gateTiers !== undefined && !(Array.isArray(f.gateTiers) && f.gateTiers.length > 0 && f.gateTiers.every((t) => isStr(t) && /^[a-z0-9][a-z0-9-]*$/.test(t)))) e.push('predeploy.fastLane.gateTiers: non-empty array of gate tier names whose pass stamp counts as "gate green" (default ["gate"])');
  for (const k of ["allow", "deny"]) {
    if (f[k] === undefined) continue;
    if (!(Array.isArray(f[k]) && f[k].every(isStr))) { e.push(`predeploy.fastLane.${k}: array of glob strings`); continue; }
    f[k].forEach((g, i) => {
      try { globToRegExp(g); } catch (x) { e.push(`predeploy.fastLane.${k}[${i}]: ${x.message}`); }
      if (k === "allow" && /^(\*\*\/?)?\*?\*?$/.test(posix(g).trim())) e.push(`predeploy.fastLane.allow[${i}]: "${g}" allows everything - list the specific source areas that may ship ahead of the full run`);
    });
  }
  if (f.targets !== undefined) {
    if (!isObj(f.targets) || Object.keys(f.targets).length === 0) e.push('predeploy.fastLane.targets: non-empty object { "<target>": "default" | "owner-only" | "off" }, e.g. { "staging": "default", "production": "owner-only" }');
    else {
      const declared = new Set((p.deployGuard?.patterns || []).map((pt) => pt?.target).filter(isStr));
      for (const [t, mode] of Object.entries(f.targets)) {
        if (!TARGET_NAME.test(t)) e.push(`predeploy.fastLane.targets.${t}: target names are lowercase letters, digits and hyphens`);
        else if (t !== PRODUCTION && !declared.has(t)) e.push(`predeploy.fastLane.targets.${t}: no predeploy.deployGuard.patterns entry has target "${t}", so no deploy would ever be identified as this target`);
        if (!TARGET_MODES.includes(mode)) e.push(`predeploy.fastLane.targets.${t}: must be one of ${TARGET_MODES.join(" | ")}`);
      }
    }
  }
  if (f.enabled === true && !(Array.isArray(f.allow) && f.allow.length > 0)) e.push("predeploy.fastLane.allow: required non-empty array when the lane is enabled (a path that matches no allow pattern is never eligible)");
  return e;
}
