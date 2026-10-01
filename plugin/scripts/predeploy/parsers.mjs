/**
 * parsers.mjs — turn each scanner's raw output into normalized findings:
 *   { id, severity: info|low|medium|high|critical, message, location }
 *
 * RULES THAT MAKE THE GATE HONEST
 *  - A parser NEVER returns "clean" for output it could not read. Missing or
 *    unparseable report => a `no-report` / `unparseable-report` finding. A
 *    scanner that crashed must not look like a scanner that found nothing.
 *  - Severity is only used for the optional per-check minSeverity floor
 *    (default "info" = everything counts, warnings and notes included).
 *    Unknown severities rank as "high", never "info".
 */

const bad = (id, message) => [{ id, severity: "high", message, location: "" }];

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function sevFromWord(w) {
  const s = String(w ?? "").toLowerCase();
  if (["critical", "crit"].includes(s)) return "critical";
  if (["high", "error", "err", "serious"].includes(s)) return "high";
  if (["medium", "moderate", "warning", "warn"].includes(s)) return "medium";
  if (["low", "minor", "style"].includes(s)) return "low";
  if (["info", "informational", "note", "unknown", "negligible", "none"].includes(s)) return "info";
  return "high";
}

function sevFromCvss(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "high";
  if (n >= 9) return "critical";
  if (n >= 7) return "high";
  if (n >= 4) return "medium";
  if (n > 0) return "low";
  return "info";
}

function loc(file, line) {
  return line ? `${file}:${line}` : String(file ?? "");
}

/** Every report named in `names` must exist; returns { texts } or { fail: findings }. */
function need(ctx, names) {
  const texts = [];
  for (const n of names) {
    const t = ctx.readReport(n);
    if (t === null || t === undefined || t.trim() === "") {
      return { fail: bad("no-report", `expected report ${n} was not produced — the scanner did not complete`) };
    }
    texts.push(t);
  }
  return { texts };
}

export const PARSERS = {
  /** Non-zero exit = one finding. For lint/typecheck/knip/depcruise etc. with their own zero-warning flags. */
  "exit-code"(ctx) {
    if (ctx.status === 0) return [];
    const tail = (ctx.stdout + "\n" + ctx.stderr).trim().split(/\r?\n/).slice(-12).join("\n");
    return [{ id: "exit-nonzero", severity: "high", message: `exited ${ctx.status}\n${tail}`, location: "" }];
  },

  /** Every non-empty stdout line is a finding (gcc-style tool output). A non-zero exit with empty stdout still fails. */
  lines(ctx) {
    const lines = ctx.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length) return lines.map((l) => ({ id: "line", severity: "medium", message: l, location: "" }));
    return ctx.status === 0 ? [] : PARSERS["exit-code"](ctx);
  },

  "gitleaks-json"(ctx) {
    const r = need(ctx, ctx.reports);
    if (r.fail) return r.fail;
    const out = [];
    for (const t of r.texts) {
      const p = parseJson(t);
      if (!p.ok || !Array.isArray(p.value)) return bad("unparseable-report", "gitleaks report is not a JSON array");
      for (const f of p.value) {
        out.push({ id: f.RuleID || "gitleaks", severity: "high", message: `${f.Description || "secret"} (${f.Commit ? "commit " + String(f.Commit).slice(0, 8) : "worktree"})`, location: loc(f.File, f.StartLine) });
      }
    }
    return out;
  },

  "semgrep-json"(ctx) {
    const r = need(ctx, ctx.reports);
    if (r.fail) return r.fail;
    const p = parseJson(r.texts[0]);
    if (!p.ok || !Array.isArray(p.value.results)) return bad("unparseable-report", "semgrep report has no results array");
    const out = p.value.results.map((x) => ({ id: x.check_id, severity: sevFromWord(x.extra?.severity), message: String(x.extra?.message || "").split("\n")[0], location: loc(x.path, x.start?.line) }));
    for (const e of p.value.errors || []) out.push({ id: "semgrep-error", severity: "high", message: String(e.message || e.type || "error").slice(0, 300), location: e.path || "" });
    return out;
  },

  "osv-json"(ctx) {
    const r = need(ctx, ctx.reports);
    if (r.fail) return r.fail;
    const p = parseJson(r.texts[0]);
    if (!p.ok || !Array.isArray(p.value.results)) return bad("unparseable-report", "osv-scanner report has no results array");
    const out = [];
    for (const res of p.value.results) {
      for (const pkg of res.packages || []) {
        const sevByVuln = new Map();
        for (const g of pkg.groups || []) for (const id of g.ids || []) sevByVuln.set(id, g.max_severity);
        for (const v of pkg.vulnerabilities || []) {
          const sc = sevByVuln.get(v.id);
          out.push({ id: v.id, severity: sc !== undefined && sc !== "" ? sevFromCvss(sc) : sevFromWord(v.database_specific?.severity), message: `${pkg.package?.name}@${pkg.package?.version}: ${v.summary || v.id}`, location: res.source?.path || "" });
        }
      }
    }
    return out;
  },

  "npm-audit-json"(ctx) {
    const r = need(ctx, ctx.reports);
    if (r.fail) return r.fail;
    const out = [];
    ctx.reports.forEach((name, i) => {
      const p = parseJson(r.texts[i]);
      if (!p.ok) return out.push(...bad("unparseable-report", `${name} is not JSON`));
      if (p.value.error) return out.push({ id: "npm-audit-error", severity: "high", message: `${name}: ${p.value.error.summary || p.value.error.code}`, location: name });
      for (const [pkg, v] of Object.entries(p.value.vulnerabilities || {})) {
        out.push({ id: `${pkg}`, severity: sevFromWord(v.severity), message: `${pkg} (${v.severity}) ${v.isDirect ? "direct" : "transitive"}${v.fixAvailable ? "" : ", no fix"}`, location: name.replace(/^npm-audit-/, "").replace(/\.json$/, "") });
      }
    });
    return out;
  },

  "trivy-json"(ctx) {
    const r = need(ctx, ctx.reports);
    if (r.fail) return r.fail;
    const out = [];
    for (const t of r.texts) {
      const p = parseJson(t);
      if (!p.ok) return bad("unparseable-report", "trivy report is not JSON");
      for (const res of p.value.Results || []) {
        for (const v of res.Vulnerabilities || []) out.push({ id: v.VulnerabilityID, severity: sevFromWord(v.Severity), message: `${v.PkgName}@${v.InstalledVersion}: ${v.Title || v.VulnerabilityID}`, location: res.Target });
        for (const m of res.Misconfigurations || []) {
          if (m.Status !== "PASS") out.push({ id: m.ID || m.AVDID, severity: sevFromWord(m.Severity), message: m.Title || m.Message || "", location: loc(res.Target, m.CauseMetadata?.StartLine) });
        }
        for (const s of res.Secrets || []) out.push({ id: s.RuleID, severity: sevFromWord(s.Severity), message: s.Title || "secret", location: loc(res.Target, s.StartLine) });
        for (const l of res.Licenses || []) out.push({ id: `license:${l.Name}`, severity: sevFromWord(l.Severity), message: `${l.PkgName}: ${l.Name}`, location: res.Target });
      }
    }
    return out;
  },

  "shellcheck-json"(ctx) {
    const r = need(ctx, ctx.reports);
    if (r.fail) return r.fail;
    const p = parseJson(r.texts[0]);
    const list = p.ok ? (Array.isArray(p.value) ? p.value : p.value.comments) : null;
    if (!Array.isArray(list)) return bad("unparseable-report", "shellcheck report is not json1/json");
    return list.map((c) => ({ id: `SC${c.code}`, severity: sevFromWord(c.level), message: c.message, location: loc(c.file, c.line) }));
  },

  "actionlint-json"(ctx) {
    const t = ctx.stdout.trim();
    if (t === "" || t === "null") return ctx.status && ctx.status > 1 ? PARSERS["exit-code"](ctx) : [];
    const p = parseJson(t);
    if (!p.ok || !Array.isArray(p.value)) return bad("unparseable-report", "actionlint output is not a JSON array");
    return p.value.map((e) => ({ id: e.kind || "actionlint", severity: "medium", message: e.message, location: loc(e.filepath, e.line) }));
  },

  /** The hadolint preset prints a JSON array of { file, items }. */
  "hadolint-json"(ctx) {
    const p = parseJson(ctx.stdout);
    if (!p.ok || !Array.isArray(p.value)) return bad("unparseable-report", "hadolint wrapper output is not JSON");
    const out = [];
    for (const f of p.value) for (const i of f.items || []) out.push({ id: i.code, severity: sevFromWord(i.level), message: i.message, location: loc(f.file, i.line) });
    return out;
  },

  "checkov-json"(ctx) {
    const r = need(ctx, ctx.reports);
    if (r.fail) return r.fail;
    const p = parseJson(r.texts[0]);
    if (!p.ok) return bad("unparseable-report", "checkov report is not JSON");
    const docs = Array.isArray(p.value) ? p.value : [p.value];
    const out = [];
    for (const d of docs) {
      for (const c of d.results?.failed_checks || []) out.push({ id: c.check_id, severity: sevFromWord(c.severity || "medium"), message: `${c.check_name} [${c.resource}]`, location: loc(c.file_path, c.file_line_range?.[0]) });
      for (const e of d.results?.parsing_errors || []) out.push({ id: "checkov-parse-error", severity: "high", message: String(e), location: String(e) });
    }
    return out;
  },

  "tflint-json"(ctx) {
    const p = parseJson(ctx.stdout.trim());
    if (!p.ok) return bad("unparseable-report", "tflint output is not JSON");
    const docs = Array.isArray(p.value) ? p.value : [p.value];
    const out = [];
    for (const d of docs) {
      for (const i of d.issues || []) out.push({ id: i.rule?.name || "tflint", severity: sevFromWord(i.rule?.severity), message: i.message, location: loc(i.range?.filename, i.range?.start?.line) });
      for (const e of d.errors || []) out.push({ id: "tflint-error", severity: "high", message: e.message || String(e), location: e.range?.filename || "" });
    }
    return out;
  },

  "zap-json"(ctx) {
    const r = need(ctx, ctx.reports);
    if (r.fail) return r.fail;
    const p = parseJson(r.texts[0]);
    if (!p.ok || !Array.isArray(p.value.site)) return bad("unparseable-report", "ZAP report has no site array");
    const risk = { 0: "info", 1: "low", 2: "medium", 3: "high" };
    const out = [];
    for (const site of p.value.site) {
      for (const a of site.alerts || []) {
        const n = (a.instances || []).length;
        out.push({ id: `zap-${a.pluginid}`, severity: risk[a.riskcode] ?? "high", message: `${a.name || a.alert} (${n} instance${n === 1 ? "" : "s"})`, location: (a.instances || [])[0]?.uri || site["@name"] });
      }
    }
    return out;
  },

  "supabase-advisors-json"(ctx) {
    const r = need(ctx, ctx.reports);
    if (r.fail) return r.fail;
    const out = [];
    for (const t of r.texts) {
      const p = parseJson(t);
      if (!p.ok || !Array.isArray(p.value.lints)) return bad("unparseable-report", "advisors response has no lints array");
      for (const l of p.value.lints) out.push({ id: l.name, severity: sevFromWord(l.level), message: `${l.title}: ${String(l.detail || "").split("\n")[0]}`, location: l.cache_key || "" });
    }
    return out;
  },
};

export const PARSER_KINDS = Object.keys(PARSERS);

export function parseOutput(kind, ctx) {
  const fn = PARSERS[kind];
  if (!fn) return bad("unknown-parser", `no parser named "${kind}"`);
  try {
    return fn(ctx);
  } catch (e) {
    return bad("parser-crashed", `${kind}: ${e.message}`);
  }
}
