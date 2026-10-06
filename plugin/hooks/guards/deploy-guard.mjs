// Guard: the pre-deploy gate (D060), enforced inside the D065 dispatcher.
//
//  1. Deploy commands are BLOCKED unless a valid predeploy stamp exists for HEAD (stamp for this exact
//     sha, not expired, config + allowlist hashes unchanged, tracked tree clean, no unscanned live-deploy
//     debt). An allowed deploy is appended to the deploy ledger (which later blocks the NEXT deploy until
//     a clean live scan covers it). "Deploy command" = the BASELINE patterns below (wrangler deploy /
//     pages deploy, supabase db push / functions deploy, terraform apply, vercel --prod) PLUS whatever
//     predeploy.deployGuard.patterns adds — config can only add, never empty the baseline (an explicitly
//     empty `patterns` is a config error) — PLUS a `git push` whose destination ref is the configured
//     repo.prodBranch (only when it differs from the landing branch, so single-branch repos are untouched).
//  2. The gate's own state (stamps, ledger, live-scan records, the emergency override) cannot be written
//     by tool commands — a stamp is only ever produced by the gate runner.
//  3. Editing the allowlist or maple.config.json forces an `ask` (owner approval).
//
// No bypass flag. The only override is the owner's interactive emergency override (needs a TTY and a typed
// phrase; default off; logged). Fails open only on malformed hook input; a missing/invalid stamp, and an
// internal error on a deploy-shaped command, fail CLOSED.
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitInfo, inspectableArgs, isDataOnly, parseShell } from "./shell.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PD = join(HERE, "..", "..", "scripts", "predeploy");

/** Built-in deploy commands. Config adds to these; it can never remove or shadow them. */
export const BASELINE_PATTERNS = [
  { id: "wrangler-deploy", description: "wrangler deploy / pages deploy / publish", regex: "\\bwrangler\\b(?:\\s+\\S+)*?\\s+(?:pages\\s+)?(?:deploy|publish)\\b" },
  { id: "supabase-db-push", description: "supabase db push", regex: "\\bsupabase\\b(?:\\s+\\S+)*?\\s+db\\s+push\\b" },
  { id: "supabase-functions-deploy", description: "supabase functions deploy", regex: "\\bsupabase\\b(?:\\s+\\S+)*?\\s+functions\\s+deploy\\b" },
  { id: "terraform-apply", description: "terraform / tofu apply", regex: "\\b(?:terraform|tofu)\\b(?:\\s+-\\S+)*\\s+apply\\b" },
  { id: "vercel-prod", description: "vercel --prod / vercel deploy --prod", regex: "\\bvercel\\b(?=.*\\s--prod(?:uction)?\\b)" },
];

/** Loose shape used ONLY to decide whether an internal failure must fail closed. */
export const DEPLOY_SHAPED = /(^|[\s/\\])(deploy[\w.-]*|terraform\s+apply|tofu\s+apply|db\s+push|functions\s+deploy|wrangler|vercel\b.*--prod)\b/i;

const READ_ONLY_VERBS = new Set([
  "grep", "egrep", "rg", "cat", "sed", "awk", "head", "tail", "ls", "dir", "type", "less", "more", "wc", "diff", "code", "vim", "nano",
  "get-content", "select-string", "gc", "sls", "findstr", "man", "help", "which", "where", "test", "[",
]);

export function effectivePatterns(configured) {
  return [...BASELINE_PATTERNS, ...(Array.isArray(configured) ? configured : [])];
}

/** Text of a segment a deploy pattern is matched against: verb + inspectable args (messages dropped). */
function segText(seg) {
  return [seg.verb, ...inspectableArgs(seg).map((w) => w.text)].join(" ");
}

/** @returns the first pattern that matches an EXECUTING segment, else null. `$(...)` / backtick bodies are segments too. */
export function matchDeploy(command, patterns, shell = "bash") {
  for (const seg of parseShell(command, shell)) {
    if (isDataOnly(seg) || READ_ONLY_VERBS.has(seg.verb)) continue;
    const isGit = seg.verb === "git";
    const text = segText(seg);
    for (const p of patterns) {
      if (isGit && !/git/i.test(p.regex)) continue; // git subcommands are not deploys unless the pattern says so
      let re;
      try { re = new RegExp(p.regex, "i"); } catch { continue; }
      if (re.test(text)) return p;
    }
  }
  return null;
}

const STATE_RE = /maple[\\/]predeploy[\\/]?(stamps|emergency|live-scans|deploys|reports)?|emergency\.json|deploys\.jsonl/i;
const PURE_READ_VERBS = new Set(["cat", "ls", "dir", "type", "head", "tail", "grep", "egrep", "rg", "get-content", "select-string", "gc", "sls", "wc", "findstr"]);

export function touchesGateState(command, shell = "bash") {
  // A reader is exempt only when it neither redirects (`>`), edits in place, nor pipes into a writer.
  return parseShell(command, shell).some((seg) => {
    const words = inspectableArgs(seg, { includeRedir: true });
    if (!words.some((w) => STATE_RE.test(w.text)) && !STATE_RE.test(seg.verb)) return false;
    const g = gitInfo(seg);
    const pureRead = PURE_READ_VERBS.has(seg.verb) || (g && ["log", "show", "status", "diff"].includes(g.sub));
    const writes = seg.words.some((w) => w.redir) || (seg.verb === "sed" && seg.args.some((a) => /^-[A-Za-z]*i/.test(a.text)));
    return !(pureRead && !writes);
  });
}

/** Destination ref(s) of a `git push` segment; "*" = pushes every branch (--all/--mirror); null = not a push. */
export function pushDestinations(seg, currentBranch) {
  const g = gitInfo(seg);
  if (!g || g.sub !== "push") return null;
  const valueFlags = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
  const pos = [];
  const a = inspectableArgs(seg).filter((w) => g.args.includes(w));
  for (let n = 0; n < a.length; n++) {
    const t = a[n].text;
    if (t === "--all" || t === "--mirror") return ["*"];
    if (valueFlags.has(t)) { n++; continue; }
    if (t.startsWith("-")) continue;
    pos.push(t);
  }
  const specs = pos.slice(1); // pos[0] is the remote
  if (specs.length === 0) return [currentBranch()];
  return specs.map((s) => {
    const spec = s.replace(/^\+/, "");
    const dst = spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : spec;
    const ref = dst.replace(/^refs\/heads\//, "");
    return ref === "HEAD" ? currentBranch() : ref;
  });
}

function prodPushHit(ctx, root, cfg, pd) {
  const prod = cfg?.repo?.prodBranch;
  const landing = cfg?.repo?.devBranch || "main";
  if (!prod || prod === landing || !pd) return null;
  for (const seg of ctx.segments()) {
    const g = gitInfo(seg);
    if (!g || g.sub !== "push") continue;
    const dir = g.dir ? resolve(seg.cd || ctx.cwd, g.dir) : seg.cd || ctx.cwd;
    let branch;
    const currentBranch = () => {
      if (branch === undefined) {
        const r = spawnSync("git", ["-C", dir, "branch", "--show-current"], { encoding: "utf8", windowsHide: true });
        branch = r.status === 0 ? r.stdout.trim() : "";
      }
      return branch;
    };
    const dests = pushDestinations(seg, currentBranch) || [];
    if (dests.includes("*") || dests.includes(prod)) {
      return { id: "prod-branch-push", description: `git push to the production branch "${prod}"` };
    }
  }
  return null;
}

function stateWriteDenied() {
  return "BLOCKED (predeploy-guard): the gate's state (stamps, deploy ledger, live-scan records, emergency override) is written only by the gate runner.";
}

export async function check(ctx) {
  const { tool, input } = ctx;
  const { root, cfg, invalid } = ctx.config();
  if (!root) return undefined;
  const isShell = tool === "Bash" || tool === "PowerShell";
  if (invalid) {
    // maple.config.json exists but does not parse: fail CLOSED on deploy-shaped commands.
    if (isShell && DEPLOY_SHAPED.test(ctx.command) && ctx.segments().some((s) => !READ_ONLY_VERBS.has(s.verb) && !isDataOnly(s) && s.verb !== "git")) {
      return { deny: "BLOCKED (predeploy-guard): maple.config.json is not valid JSON, so the deploy guard cannot read its patterns; deploy-shaped commands are refused until it parses." };
    }
    return undefined;
  }
  const { normalize } = await import(pathToFileURL(join(PD, "config.mjs")).href);
  const pd = normalize(cfg);
  if (!pd || pd.enabled === false) return undefined;

  if (/^(Write|Edit|MultiEdit)$/.test(tool)) {
    const file = input.file_path || input.path || "";
    if (!file) return undefined;
    const abs = resolve(ctx.cwd, file);
    if (STATE_RE.test(abs) && abs.includes(`maple${sep}predeploy`)) return { deny: stateWriteDenied() };
    const rel = relative(root, abs).split(sep).join("/");
    const norm = (v) => String(v).replace(/\\/g, "/");
    if (rel === norm(pd.decisions)) {
      return { ask: `Owner approval needed: ${rel} holds PERMANENT decision-backed exceptions. Essentials only — each entry needs an existing D###, a "cannot be fixed" reason and a fresh review date. If it can be fixed, fix it instead.` };
    }
    if (pd.imageDebt && rel === norm(pd.imageDebt.file)) {
      return { ask: `Owner approval needed: ${rel} is the dated third-party image debt ledger. Snapshots are written only by \`run.mjs --rebaseline-image-debt\` (a reviewable diff); due dates are never extended, and our own images can never be listed.` };
    }
    if (rel === norm(pd.allowlist) || rel === "maple.config.json") {
      return { ask: `Owner approval needed: ${rel} defines the pre-deploy gate's exceptions/configuration. Allowlist entries need a reason, an owner and an expiry — confirm this change is reviewed.` };
    }
    return undefined;
  }

  if (!isShell || !ctx.command) return undefined;
  if (touchesGateState(ctx.command, ctx.shell)) {
    return { deny: "BLOCKED (predeploy-guard): this command touches the gate's state directory (maple/predeploy). Stamps, the deploy ledger and the emergency override are written only by the gate runner / the owner's interactive override." };
  }

  const hit = matchDeploy(ctx.command, effectivePatterns(pd.deployGuard?.patterns), ctx.shell) || prodPushHit(ctx, root, cfg, pd);
  if (!hit) return undefined;

  const { verifyStamp, appendLedger } = await import(pathToFileURL(join(PD, "state.mjs")).href);
  const v = verifyStamp(root);
  if (!v.ok) {
    return {
      deny:
        `BLOCKED (predeploy-guard): deploy command "${hit.id}"${hit.description ? " (" + hit.description + ")" : ""} refused — ${v.reason}.\n` +
        `  Run /predeploy-gate (node "<plugin>/scripts/predeploy/run.mjs") on a clean tree at the commit you intend to deploy; it must finish with STAMP ISSUED.\n` +
        `  There is no bypass flag. The owner's emergency override is documented in docs/predeploy-gate.md (default off).`,
    };
  }
  try {
    appendLedger(root, { sha: v.sha, patternId: hit.id, command: ctx.command.slice(0, 200).replace(/(token|secret|password|key)[=:\s]+\S+/gi, "$1=<redacted>"), emergency: Boolean(v.emergency) });
  } catch { /* ledger failure must not wedge a legitimately stamped deploy */ }
  return v.emergency ? { warn: `WARNING (predeploy-guard): EMERGENCY OVERRIDE in effect — ${v.reason}` } : undefined;
}

/** Used by the dispatcher on internal error/deadline: deny only when the command LOOKS like a deploy. */
export function failClosed(ctx, why) {
  if ((ctx.tool === "Bash" || ctx.tool === "PowerShell") && DEPLOY_SHAPED.test(ctx.command)) {
    return { deny: `BLOCKED (predeploy-guard): ${why} while checking a deploy-shaped command. Failing closed.` };
  }
  return undefined;
}
