/**
 * internal.mjs — presets implemented in JS rather than as one shell command:
 * terraform, hadolint, trivy-image, deps-freshness, supabase-advisors,
 * gh-alerts, suppression-audit. Each `run(options, ctx)` resolves to
 * `{ findings, notes? }` and NEVER reports clean for something it could not
 * evaluate (missing tool / token / network => a finding).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTool, shq, nativePath } from "./tools.mjs";
import { parseOutput, sevFromWord } from "./parsers.mjs";
import { getCredential, credentialExists } from "./credentials.mjs";
import { git, runShellAsync } from "./lib.mjs";
import { pool, spawnAsync } from "./proc.mjs";
import { stackExposure } from "./exposure.mjs";
import { trivyImage } from "./trivy-image.mjs";

const F = (id, message, location = "", severity = "high") => ({ id, severity, message, location });

function tool(ctx, name) {
  const t = resolveTool(name, { allowDocker: ctx.docker, pull: ctx.pull });
  if (t.mode === "missing") return { missing: F("tool-missing", `${name}: ${t.reason}`) };
  return { t };
}

/** Every tool call inside a check is non-blocking, so the gate's other checks keep running meanwhile. */
function capture(command, opts = {}) {
  return runShellAsync(command, { timeoutSec: 1800, ...opts });
}

// ── terraform ───────────────────────────────────────────────────────────────
async function terraform(o, ctx) {
  const { t, missing } = tool(ctx, "terraform");
  if (missing) return { findings: [missing] };
  const dirs = o.dirs || ctx.listFiles(/\.tf$/).map((f) => f.replace(/\/[^/]*$/, "") || ".").filter((d, i, a) => a.indexOf(d) === i && !/(^|\/)modules\//.test(d));
  if (!dirs.length) return { findings: [], notes: ["no terraform directories"] };
  const cache = join(ctx.stateDir, "tf-plugin-cache");
  mkdirSync(cache, { recursive: true });
  const env = { TF_PLUGIN_CACHE_DIR: cache, TF_IN_AUTOMATION: "1", CHECKPOINT_DISABLE: "1" };
  const findings = [];
  for (const d of dirs) {
    const cwd = join(ctx.scanRoot, d);
    const init = await capture(`terraform init -backend=false -input=false -no-color`, { cwd, env });
    if (init.status !== 0) {
      findings.push(F("terraform-init", `terraform init failed: ${(init.stderr || init.stdout).trim().split(/\r?\n/).slice(-3).join(" | ")}`, d));
      continue;
    }
    const val = await capture(`terraform validate -json -no-color`, { cwd, env });
    try {
      const j = JSON.parse(val.stdout);
      for (const dg of j.diagnostics || []) findings.push(F(`terraform-validate-${dg.severity}`, `${dg.summary}: ${dg.detail || ""}`.slice(0, 300), `${d}/${dg.range?.filename || ""}:${dg.range?.start?.line || ""}`, dg.severity === "error" ? "high" : "medium"));
    } catch {
      findings.push(F("terraform-validate", "validate produced no JSON", d));
    }
  }
  const fmt = await capture(`terraform fmt -check -recursive -no-color ${shq(ctx.scanRootPosix + "/" + (o.fmtDir || "."))}`);
  if (fmt.status !== 0) for (const l of fmt.stdout.split(/\r?\n/).filter(Boolean)) findings.push(F("terraform-fmt", "file is not canonically formatted", l.replace(ctx.scanRootPosix + "/", ""), "low"));
  return { findings, notes: [`terraform ${t.version}`] };
}

// ── hadolint ────────────────────────────────────────────────────────────────
async function hadolint(o, ctx) {
  const { t, missing } = tool(ctx, "hadolint");
  if (missing) return { findings: [missing] };
  const files = ctx.listFiles(/(^|\/)Dockerfile[^/]*$/).filter((f) => !(o.exclude || []).some((p) => f.startsWith(p)));
  const results = [];
  for (const f of files) {
    const abs = join(ctx.scanRoot, f);
    const content = readFileSync(abs);
    const args = ["--format", "json", "--no-color", "-t", "style", "-"];
    const r = t.mode === "native"
      ? await spawnAsync(t.bin, args, { input: content, cwd: ctx.outDir })
      : await spawnAsync("docker", ["run", "--rm", "-i", t.image, "hadolint", ...args], { input: content });
    let items;
    try { items = JSON.parse(r.stdout || "[]"); } catch { return { findings: [F("hadolint-crash", `hadolint output for ${f} was not JSON: ${(r.stderr || "").slice(0, 200)}`, f)] }; }
    results.push({ file: f, items });
  }
  return { findings: parseOutput("hadolint-json", { stdout: JSON.stringify(results), reports: [], readReport: () => null }), notes: [`${files.length} Dockerfile(s)`] };
}

// ── snyk ────────────────────────────────────────────────────────────────────
/**
 * Snyk Open Source over every tracked lockfile of the clean candidate tree (`snyk test --all-projects --dev`, every
 * severity). The account token is read JUST-IN-TIME from the credential store (options.tokenCredential, default
 * "Snyk-Token") and handed to the snyk child as SNYK_TOKEN in ITS environment only: never set in this process, never
 * written to a file/report/log/argv, and `snyk auth` (which persists it in plaintext config) is never run. A missing
 * token or CLI, an auth failure or "no supported projects" is a finding — never a skip. `.snyk` policy files are removed
 * from the scan copy (run.mjs), so ignores cannot hide a finding.
 */
async function snyk(o, ctx) {
  const { t, missing } = tool({ ...ctx, docker: false }, "snyk");
  if (missing) return { findings: [missing] };
  const target = o.tokenCredential || "Snyk-Token";
  const token = getCredential(target);
  if (!token) return { findings: [F("token-missing", `no Snyk token: store credential "${target}" (credential-manager skill) — the gate reads it just-in-time, never from a file`, target)] };
  const r = await spawnAsync(t.bin, ["test", "--all-projects", "--dev", "--severity-threshold=low", "--json"], {
    cwd: ctx.scanRoot, timeout: (o.timeoutSec || 1800) * 1000, maxBuffer: 512 * 1024 * 1024,
    shell: process.platform === "win32", env: { ...process.env, SNYK_TOKEN: token, SNYK_DISABLE_ANALYTICS: "1" },
  });
  const scrub = (x) => String(x || "").split(token).join("***");
  if (r.error) return { findings: [F(r.error.code === "ETIMEDOUT" ? "timeout" : "spawn-failed", scrub(r.error.message), "snyk")] };
  let doc;
  try { doc = JSON.parse(r.stdout); } catch {
    return { findings: [F(r.status === 2 ? "snyk-failed" : "unparseable-report", `snyk exit ${r.status}: ${scrub(r.stderr || r.stdout).trim().split(/\r?\n/).slice(0, 3).join(" | ").slice(0, 300)}`, "snyk")] };
  }
  const projects = Array.isArray(doc) ? doc : [doc];
  const findings = [];
  const seen = new Set();
  for (const p of projects) {
    if (p.error) { findings.push(F(/auth/i.test(p.error) ? "snyk-auth-failed" : "snyk-failed", scrub(p.error).slice(0, 300), p.path || p.displayTargetFile || "snyk")); continue; }
    for (const v of p.vulnerabilities || []) {
      const resource = `${v.packageName}@${v.version}`;
      const loc = p.displayTargetFile || p.path || "";
      const key = [v.id, resource, loc].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ id: v.id, severity: sevFromWord(v.severity), message: `${resource}: ${v.title || v.id}`.slice(0, 300), location: loc, resource });
    }
  }
  if (r.status === 3 || !projects.length) findings.push(F("snyk-no-projects", "snyk found no supported projects to test", "snyk"));
  return { findings, notes: [`snyk ${t.version}: ${projects.length} project(s)`] };
}

// ── deps-freshness ──────────────────────────────────────────────────────────
const majorOf = (v) => parseInt(String(v).split(".")[0], 10);
const monthsBetween = (a, b) => (b - a) / (1000 * 60 * 60 * 24 * 30.44);

async function registryDoc(name, cache) {
  if (cache.has(name)) return cache.get(name);
  let doc = null;
  for (let attempt = 0; attempt < 3 && !doc; attempt++) {
    try {
      const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}`, { headers: { accept: "application/json" } });
      if (res.ok) {
        const j = await res.json();
        doc = { latest: j["dist-tags"]?.latest, time: j.time || {} };
      } else if (res.status === 404) break;
    } catch { /* retry */ }
  }
  cache.set(name, doc);
  return doc;
}

/**
 * STALE, concretely (defaults, all overridable in options):
 *  - deprecated:  ANY package in a lockfile (direct or transitive) that npm marks deprecated.
 *  - stale-major: a DIRECT dependency whose newest release is more than maxMajorsBehind majors ahead (default 1).
 *  - stale-age:   a DIRECT dependency, not on its latest release, whose installed version was published more than
 *                 maxMonthsBehind months ago (default 12).
 * Direct = declared in package.json (dependencies, devDependencies, optionalDependencies) and resolved from the
 * public npm registry. Private-scope packages are listed in notes, not judged.
 */
async function depsFreshness(o, ctx) {
  const maxMajors = o.maxMajorsBehind ?? 1;
  const maxMonths = o.maxMonthsBehind ?? 12;
  const now = Date.now();
  const dirs = o.dirs || ctx.lockDirs().filter((d) => !(o.exclude || []).some((p) => (d + "/").startsWith(p)));
  const findings = [];
  const notes = [];
  const cache = new Map();
  const todo = [];
  for (const d of dirs) {
    const lockPath = join(ctx.scanRoot, d, "package-lock.json");
    const pkgPath = join(ctx.scanRoot, d, "package.json");
    if (!existsSync(lockPath) || !existsSync(pkgPath)) { findings.push(F("no-lockfile", "package.json without package-lock.json cannot be evaluated", d)); continue; }
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    for (const [p, e] of Object.entries(lock.packages || {})) {
      if (e.deprecated) findings.push(F(`deprecated:${p.replace(/^.*node_modules\//, "")}`, `${p.replace(/^.*node_modules\//, "")}@${e.version} is deprecated: ${String(e.deprecated).slice(0, 160)}`, d, "medium"));
    }
    const direct = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
    for (const name of Object.keys(direct)) {
      const e = lock.packages?.[`node_modules/${name}`] || (lock.packages?.[""] && null);
      if (!e) continue; // hoisted into a workspace root
      if (e.resolved && !/registry\.npmjs\.org/.test(e.resolved)) { notes.push(`${d}: ${name} resolved from a private registry — not judged`); continue; }
      todo.push({ d, name, version: e.version });
    }
  }
  await pool(todo, 8, async ({ d, name, version }) => {
    const doc = await registryDoc(name, cache);
    if (!doc || !doc.latest) { findings.push(F(`registry-unreachable:${name}`, `could not read ${name} from the npm registry`, d)); return; }
    const behind = majorOf(doc.latest) - majorOf(version);
    if (behind > maxMajors) findings.push(F(`stale-major:${name}`, `${name}@${version} is ${behind} majors behind ${doc.latest} (limit ${maxMajors})`, d, "medium"));
    if (version !== doc.latest && doc.time[version]) {
      const months = monthsBetween(new Date(doc.time[version]).getTime(), now);
      if (months > maxMonths) findings.push(F(`stale-age:${name}`, `${name}@${version} was published ${Math.round(months)} months ago and ${doc.latest} exists (limit ${maxMonths})`, d, "low"));
    }
  });
  notes.push(`policy: majorsBehind<=${maxMajors}, monthsBehind<=${maxMonths}, deprecated=0; ${todo.length} direct deps judged`);
  return { findings, notes };
}

// ── supabase-advisors ───────────────────────────────────────────────────────
async function supabaseAdvisors(o, ctx) {
  const ref = o.projectRef;
  if (!ref) return { findings: [F("misconfigured", "supabase-advisors needs options.projectRef")] };
  const target = o.tokenCredential || "Supabase-PAT";
  const token = process.env.SUPABASE_ACCESS_TOKEN || getCredential(target);
  if (!token) return { findings: [F("token-missing", `no Supabase management token: store credential "${target}" (credential-manager skill) or set SUPABASE_ACCESS_TOKEN`, target)] };
  const findings = [];
  for (const type of o.types || ["security", "performance"]) {
    let res;
    try {
      res = await fetch(`https://api.supabase.com/v1/projects/${ref}/advisors/${type}`, { headers: { authorization: `Bearer ${token}` } });
    } catch (e) {
      findings.push(F("advisors-unreachable", `${type}: ${e.message}`)); continue;
    }
    if (!res.ok) { findings.push(F("advisors-http-error", `${type}: HTTP ${res.status} (experimental endpoint; token must be able to read the project)`)); continue; }
    const body = await res.text();
    for (const f of parseOutput("supabase-advisors-json", { reports: ["a"], readReport: () => body })) findings.push({ ...f, id: `${type}:${f.id}` });
  }
  return { findings };
}

// ── gh-alerts ───────────────────────────────────────────────────────────────
async function ghAlerts(o, ctx) {
  const gh = resolveTool("gh");
  if (gh.mode === "missing") return { findings: [F("tool-missing", `gh: ${gh.reason}`)] };
  const repo = o.repo || ((await capture("gh repo view --json nameWithOwner --jq .nameWithOwner", { cwd: ctx.root })).stdout || "").trim();
  if (!repo) return { findings: [F("gh-repo-unknown", "could not determine the GitHub repo (gh auth / remote)")] };
  const kinds = o.kinds || ["code-scanning", "dependabot", "secret-scanning"];
  const findings = [];
  const notes = [];
  for (const k of kinds) {
    const r = await capture(`gh api --paginate "repos/${repo}/${k}/alerts?state=open&per_page=100"`, { cwd: ctx.root });
    const text = (r.stdout + r.stderr).toLowerCase();
    if (r.status !== 0) {
      if (/disabled|not enabled|advanced security|not available/.test(text)) {
        if (o.whenDisabled === "fail") findings.push(F(`${k}-disabled`, `${k} is not enabled for ${repo}`, repo));
        else notes.push(`${k}: NOT ENABLED for ${repo} (GitHub Advanced Security / alerts off) — zero alerts by absence, not by scanning`);
      } else findings.push(F(`${k}-query-failed`, text.trim().split(/\r?\n/)[0].slice(0, 200), repo));
      continue;
    }
    let alerts = [];
    try { alerts = JSON.parse(`[${r.stdout.replace(/\]\s*\[/g, "],[").replace(/^\[|\]$/g, "")}]`); } catch { try { alerts = JSON.parse(r.stdout); } catch { findings.push(F(`${k}-unparseable`, "alerts response not JSON", repo)); continue; } }
    for (const a of alerts.flat()) findings.push(F(`${k}:${a.rule?.id || a.security_advisory?.ghsa_id || a.secret_type || a.number}`, a.rule?.description || a.security_advisory?.summary || a.secret_type_display_name || "open alert", a.html_url || repo, sevFromWord(a.rule?.security_severity_level || a.security_advisory?.severity || "high")));
  }
  return { findings, notes };
}

// ── suppression-audit ───────────────────────────────────────────────────────
const SUPPRESSION_RE = "nosemgrep|\\bnosec\\b|checkov:skip|tfsec:ignore|trivy:ignore|gitleaks:allow|#[[:space:]]*shellcheck[[:space:]]+disable|hadolint[[:space:]]+ignore|snyk:ignore|NOSONAR|codeql\\[|eslint-disable";
const IGNORE_FILES = /(^|\/)(\.eslintignore|\.semgrepignore|\.trivyignore(\.yaml)?|trivy\.ya?ml|osv-scanner\.toml|\.checkov\.ya?ml|\.hadolint\.ya?ml|\.shellcheckrc|\.gitleaksignore|\.snyk|actionlint\.ya?ml)$/;

/**
 * Config files that are ONLY a suppression when they carry certain content
 * (a gitleaks config with an allowlist, a knip config with ignore* keys). A
 * gitleaks config that merely extends the default ruleset is not flagged.
 */
const GITLEAKS_CONFIG = /(^|\/)\.?gitleaks\.toml$/;
const GITLEAKS_ALLOW = /^\s*\[\[?(rules\.)?allowlists?\]\]?/im;
const KNIP_CONFIG = /(^|\/)(\.?knip\.(jsonc?|ya?ml|[cm]?[jt]s)|knip\.config\.[cm]?[jt]s)$/;
const KNIP_IGNORE = /["']?ignore(Dependencies|Binaries|ExportsUsedInFile|Members|Unresolved|Workspaces|Issues)?["']?\s*[:=]/;

function contentSuppressions(ctx) {
  const out = [];
  const read = (f) => { try { return readFileSync(join(ctx.scanRoot, f), "utf8"); } catch { return ""; } };
  for (const f of ctx.listFiles(GITLEAKS_CONFIG)) if (GITLEAKS_ALLOW.test(read(f))) out.push(F("suppression-file:" + f.split("/").pop(), "gitleaks config declares an allowlist — silently suppresses findings", f, "medium"));
  for (const f of ctx.listFiles(KNIP_CONFIG)) if (KNIP_IGNORE.test(read(f))) out.push(F("suppression-file:" + f.split("/").pop(), "knip config declares ignore* entries — silently suppresses findings", f, "medium"));
  for (const f of ctx.listFiles(/(^|\/)package\.json$/)) {
    let k;
    try { k = JSON.parse(read(f)).knip; } catch { continue; }
    if (k && typeof k === "object" && Object.keys(k).some((key) => /^ignore/.test(key))) out.push(F("suppression-file:package.json#knip", 'package.json "knip" key declares ignore* entries — silently suppresses findings', f, "medium"));
  }
  return out;
}

/**
 * Scanners honour in-source and side-file suppressions silently, so every such
 * marker/file is ITSELF a finding (D061 policy: flagged, not mirrored). The
 * only ways a suppression survives the gate:
 *   1. it is removed (preferred; the gate ignores scanner ignore files anyway), or
 *   2. it is backed by a decision-backed entry in predeploy-decisions.json:
 *      { scanner: "suppression-audit", rule: "suppression-file:osv-scanner.toml" |
 *        "suppression:eslint-disable", scope: "<exact file path>", decision: "D###", ... }
 *      — a permanent, ledger-referenced, periodically re-reviewed exception.
 * (The expiring allowlist can also except one, by id suppression:<marker> + location.)
 */
async function suppressionAudit(o, ctx) {
  const findings = [];
  const out = git(ctx.root, ["grep", "-I", "-n", "-i", "-E", o.pattern || SUPPRESSION_RE, ctx.sha, "--", ".", ":(exclude)*.md", ":(exclude)docs", ...(ctx.exemptFiles || []).map((p) => `:(exclude)${p}`), ...(o.excludePaths || []).map((p) => `:(exclude)${p}`)]);
  for (const line of (out || "").split(/\r?\n/).filter(Boolean)) {
    const m = /^[0-9a-f]{40}:([^:]+):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const marker = (new RegExp(o.pattern || SUPPRESSION_RE.replace(/\[\[:space:\]\]/g, "\\s"), "i").exec(m[3]) || ["suppression"])[0].toLowerCase().replace(/\s+/g, " ");
    findings.push(F(`suppression:${marker}`, m[3].trim().slice(0, 140), `${m[1]}:${m[2]}`, "medium"));
  }
  for (const f of ctx.listFiles(IGNORE_FILES)) findings.push(F(`suppression-file:${f.split("/").pop()}`, "scanner ignore/config file present — silently suppresses findings", f, "medium"));
  findings.push(...contentSuppressions(ctx));
  return { findings };
}

export const INTERNAL_PRESETS = {
  terraform: { describe: "terraform init -backend=false + validate (diagnostics incl. warnings) + fmt -check, per root directory.", tools: ["terraform"], run: terraform },
  hadolint: { describe: "hadolint at style level over every tracked Dockerfile.", tools: ["hadolint"], run: hadolint },
  "trivy-image": { describe: "Trivy-scan (vuln + secret) each declared image: built from the candidate tree ({name, context}) or a third-party image pulled by its exact deployed ref ({name, ref}).", tools: ["trivy", "docker"], run: trivyImage },
  "deps-freshness": { describe: "No deprecated packages; no direct dependency too many majors or months behind (defaults 1 major / 12 months).", tools: ["node"], run: depsFreshness },
  "supabase-advisors": { describe: "Supabase security + performance advisors via the Management API (every lint level counts).", tools: [], run: supabaseAdvisors, credentials: (o) => [o.tokenCredential || "Supabase-PAT"] },
  snyk: { describe: "Snyk Open Source (all lockfiles, dev deps, every severity); token read just-in-time from the credential store into the child env only.", tools: ["snyk"], run: snyk, credentials: (o) => [o.tokenCredential || "Snyk-Token"] },
  "gh-alerts": { describe: "Open GitHub code-scanning / Dependabot / secret-scanning alerts, read locally via `gh api` (no workflow minutes).", tools: ["gh"], run: ghAlerts },
  "stack-exposure": { describe: "Stack-exposure standard (D072): builds each configured surface and fails on served source maps, sensitive files, license banners, inlined env objects, the commit SHA, package versions, non-hash asset names, dev routes, forbidden strings and an over-budget login graph; plus nginx server_tokens / express x-powered-by in the tracked tree.", tools: ["node"], run: stackExposure },
  "suppression-audit": { describe: "Scanner suppression markers (nosemgrep, checkov:skip, eslint-disable, ...) and ignore files/configs (osv-scanner.toml, .snyk, gitleaks allowlists, knip ignore*) are findings unless backed by a decision-backed entry (or the expiring allowlist).", tools: ["git"], run: suppressionAudit },
};

export { credentialExists, nativePath };
