/**
 * remote.mjs — the one place the gate spends GitHub minutes: trigger the
 * project's single predeploy workflow for the candidate SHA, wait for it, and
 * turn its result into findings.
 *
 * The trigger carries NO input (checkov CKV_GHA_7 forbids dispatch inputs that
 * affect the build). The gate pushes a lightweight tag `<tagPrefix><sha>`
 * (default `predeploy/<sha>`) pointing at the candidate; the workflow runs on
 * `push: tags: predeploy/**` and builds `github.sha`. The tag namespace is
 * created only by the gate, so ordinary pushes never run it. Only checks that
 * declare `github: <workflow>` (with a written `why`) come here.
 *
 * A successful run for the SAME sha is reused, so re-running the gate (after
 * fixing a local finding, say) never pays for the remote leg twice.
 * The candidate branch must already be pushed (the gate pushes only the
 * trigger tag, never branches): the stamp requires success for exactly this sha.
 */
import { git } from "./lib.mjs";
import { sleep, spawnAsync } from "./proc.mjs";

const F = (id, message, location = "") => ({ id, severity: "high", message, location });

/** `gh <args>` without blocking the event loop (the remote leg polls for up to 45 min next to the local checks). */
export async function ghCli(root, args) {
  const r = await spawnAsync("gh", args, { cwd: root, timeout: 120000 });
  return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || (r.error ? r.error.message : "")).trim() };
}

const gitPush = (root, args) => spawnAsync("git", ["push", ...args], { cwd: root, timeout: 120000 });

/**
 * The remote leg's first verdict, shared with the preflight: the candidate must sit on its pushed branch.
 * @returns {{ref:string|null, finding:object|null}}
 */
export function candidateOnRemote(root, pd, sha) {
  const remote = pd.remote || {};
  const ref = remote.ref || git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (!ref) return { ref: null, finding: F("remote-ref-unknown", "detached HEAD and predeploy.remote.ref not set") };
  const onRemote = git(root, ["ls-remote", "origin", `refs/heads/${ref}`]);
  const remoteSha = onRemote ? onRemote.split(/\s+/)[0] : "";
  if (remoteSha !== sha) return { ref, finding: F("sha-not-on-remote", `origin/${ref} is ${remoteSha ? remoteSha.slice(0, 8) : "absent"}, candidate is ${sha.slice(0, 8)} — push the candidate branch first (the gate never pushes)`, ref) };
  return { ref, finding: null };
}

const runListArgs = (workflow) => ["run", "list", "--workflow", workflow, "--event", "push", "--json", "databaseId,headSha,status,conclusion,createdAt,url", "-L", "30"];

export async function runRemote(check, pd, ctx) {
  const workflow = check.github;
  const remote = pd.remote || {};
  const root = ctx.root;
  const gh = ctx.gh || ghCli; // injectable for tests
  const sha = ctx.sha;
  const pushed = candidateOnRemote(root, pd, sha);
  if (pushed.finding) return { findings: [pushed.finding] };

  const tag = `${remote.tagPrefix || "predeploy/"}${sha}`;
  const list = async () => {
    const r = await gh(root, runListArgs(workflow));
    if (r.status !== 0) return { error: r.err || r.out };
    try { return { runs: JSON.parse(r.out) }; } catch { return { error: "gh run list returned non-JSON" }; }
  };

  let l = await list();
  if (l.error) return { findings: [F("gh-run-list-failed", l.error.slice(0, 300), workflow)] };
  let run = l.runs.find((x) => x.headSha === sha && x.status === "completed" && x.conclusion === "success");
  const reused = Boolean(run);
  if (!run) run = l.runs.find((x) => x.headSha === sha && x.status !== "completed");
  if (!run) {
    const started = Date.now();
    // A leftover tag from an earlier failed run would not re-trigger: delete it
    // first (a tag deletion fires no push workflow), then push it fresh.
    if (git(root, ["ls-remote", "origin", `refs/tags/${tag}`])) {
      const del = await gitPush(root, ["origin", `:refs/tags/${tag}`]);
      if (del.status !== 0) return { findings: [F("trigger-tag-delete-failed", (del.stderr || "").slice(0, 300), tag)] };
    }
    const d = await gitPush(root, ["origin", `${sha}:refs/tags/${tag}`]);
    if (d.status !== 0) return { findings: [F("trigger-tag-push-failed", (d.stderr || "").slice(0, 300), tag)] };
    for (let i = 0; i < 30 && !run; i++) {
      await sleep(4000);
      l = await list();
      run = (l.runs || []).find((x) => x.headSha === sha && new Date(x.createdAt).getTime() >= started - 15000 && x.status !== "completed") || (l.runs || []).find((x) => x.headSha === sha && new Date(x.createdAt).getTime() >= started - 15000);
    }
    if (!run) return { findings: [F("workflow-run-not-found", "tag pushed but no run appeared for this sha", workflow)] };
  }

  const deadline = Date.now() + (remote.timeoutMin || 45) * 60000;
  let view;
  for (;;) {
    const v = await gh(root, ["run", "view", String(run.databaseId), "--json", "status,conclusion,jobs,url,headSha"]);
    try { view = JSON.parse(v.out); } catch { return { findings: [F("gh-run-view-failed", v.err.slice(0, 300), String(run.databaseId))] }; }
    if (view.status === "completed") break;
    if (Date.now() > deadline) return { findings: [F("remote-timeout", `run ${run.databaseId} still ${view.status} after ${remote.timeoutMin || 45} min`, view.url)] };
    await sleep((remote.pollSec || 15) * 1000);
  }
  if (view.headSha !== sha) return { findings: [F("remote-sha-mismatch", `run tested ${String(view.headSha).slice(0, 8)}, candidate is ${sha.slice(0, 8)}`, view.url)] };
  const findings = [];
  if (view.conclusion !== "success") {
    for (const j of view.jobs || []) if (j.conclusion && j.conclusion !== "success" && j.conclusion !== "skipped") findings.push(F(`job-failed:${j.name}`, `job "${j.name}" ${j.conclusion}`, view.url));
    if (!findings.length) findings.push(F("workflow-failed", `workflow concluded ${view.conclusion}`, view.url));
  }
  return { findings, meta: { runId: run.databaseId, url: view.url, conclusion: view.conclusion, sha, reused }, notes: [`${workflow}: run ${run.databaseId} ${view.conclusion}${reused ? " (reused)" : ""}`] };
}

// ── runner probe (preflight) ────────────────────────────────────────────────
/**
 * Self-hosted label sets the workflow's jobs run on (`runs-on: [self-hosted, docker, x]`, `runs-on: self-hosted`, a
 * block list, or `labels:` under the group form). Jobs on GitHub-hosted runners are ignored. `unknown` is set when a
 * `runs-on` uses an expression the probe cannot evaluate.
 */
export function selfHostedLabelSets(yaml) {
  const sets = [];
  let unknown = false;
  const lines = String(yaml || "").split(/\r?\n/);
  const clean = (v) => v.replace(/\s#.*$/, "").trim().replace(/^["']|["']$/g, "");
  const inline = (v) => v.replace(/^\[|\]$/g, "").split(",").map(clean).filter(Boolean);
  const indentOf = (l) => /^(\s*)/.exec(l)[1].length;
  const listItems = (from, indent) => {
    const out = [];
    for (let j = from; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      const m = /^(\s*)-\s*(.+)$/.exec(lines[j]);
      if (!m || m[1].length < indent) break;
      out.push(clean(m[2]));
    }
    return out;
  };
  lines.forEach((line, i) => {
    const m = /^(\s*)runs-on:\s*(.*)$/.exec(line);
    if (!m) return;
    const indent = m[1].length;
    const v = clean(m[2]);
    let labels = v.startsWith("[") ? inline(v) : v ? [v] : listItems(i + 1, indent);
    if (!v && !labels.length) {
      for (let j = i + 1; j < lines.length && (!lines[j].trim() || indentOf(lines[j]) > indent); j++) {
        const lm = /^(\s*)labels:\s*(.*)$/.exec(lines[j]);
        if (!lm) continue;
        const lv = clean(lm[2]);
        labels = lv.startsWith("[") ? inline(lv) : lv ? [lv] : listItems(j + 1, lm[1].length);
      }
    }
    if (labels.some((l) => l.includes("${{"))) { unknown = true; return; }
    if (labels.some((l) => l.toLowerCase() === "self-hosted")) sets.push(labels);
  });
  return { sets, unknown };
}

/**
 * Is a runner online for the remote leg? The same question the remote leg answers the slow way (queued until
 * remote.timeoutMin). Fails only on evidence: matching repo runners exist and none is online. A reusable green run
 * for this sha needs no runner at all. Anything the probe cannot see (no admin scope, org-level runners, an
 * expression in runs-on) is a warning, never a failure.
 * @returns {Promise<{finding?:object, warning?:string, note?:string}>}
 */
export async function runnerProbe(root, pd, check, sha, { gh = ghCli } = {}) {
  const workflow = check.github;
  const yaml = git(root, ["show", `${sha}:.github/workflows/${workflow}`]);
  if (yaml === null) return { warning: `${check.id}: cannot read .github/workflows/${workflow} at ${sha.slice(0, 8)} — runner not probed` };
  const { sets, unknown } = selfHostedLabelSets(yaml);
  if (!sets.length) return unknown ? { warning: `${check.id}: runs-on uses an expression — runner not probed` } : { note: `${check.id}: GitHub-hosted runners` };
  const l = await gh(root, runListArgs(workflow));
  try {
    if (l.status === 0 && JSON.parse(l.out).some((x) => x.headSha === sha && x.status === "completed" && x.conclusion === "success")) return { note: `${check.id}: a green ${workflow} run for ${sha.slice(0, 8)} exists and will be reused — no runner needed` };
  } catch { /* fall through to the runner probe */ }
  const repoR = await gh(root, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const repo = repoR.status === 0 ? repoR.out.trim() : "";
  const why = (x, dflt) => (x.err || dflt).split(/\r?\n/)[0].slice(0, 120);
  if (!repo) return { warning: `${check.id}: cannot resolve the GitHub repo (${why(repoR, "gh repo view failed")}) — runner not probed` };
  const r = await gh(root, ["api", `repos/${repo}/actions/runners?per_page=100`]);
  let runners;
  try { runners = r.status === 0 ? JSON.parse(r.out).runners : null; } catch { runners = null; }
  if (!Array.isArray(runners)) return { warning: `${check.id}: cannot list ${repo} runners (${why(r, "gh api failed")}; needs repo admin) — runner not probed` };
  for (const set of sets) {
    const want = set.map((s) => s.toLowerCase());
    const matching = runners.filter((x) => want.every((w) => (x.labels || []).some((lb) => String(lb.name).toLowerCase() === w)));
    if (!matching.length) return { warning: `${check.id}: no repo-level runner carries [${set.join(", ")}] (org-level runners are not visible here) — runner not probed` };
    if (!matching.some((x) => x.status === "online")) {
      return { finding: F("runner-offline", `no online runner for ${workflow} [${set.join(", ")}]: ${matching.length} registered, all offline (${matching.map((x) => x.name).join(", ")}) — start the runner, then re-run; the remote leg would sit queued up to ${(pd.remote || {}).timeoutMin || 45} min`, workflow) };
    }
  }
  return { note: `${check.id}: self-hosted runner online` };
}
