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
import { spawnSync } from "node:child_process";
import { git } from "./lib.mjs";

const F = (id, message, location = "") => ({ id, severity: "high", message, location });

function ghCli(root, args) {
  const r = spawnSync("gh", args, { cwd: root, encoding: "utf8", timeout: 120000 });
  return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runRemote(check, pd, ctx) {
  const workflow = check.github;
  const remote = pd.remote || {};
  const root = ctx.root;
  const gh = ctx.gh || ghCli; // injectable for tests
  const sha = ctx.sha;
  const ref = remote.ref || git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (!ref) return { findings: [F("remote-ref-unknown", "detached HEAD and predeploy.remote.ref not set")] };

  const onRemote = git(root, ["ls-remote", "origin", `refs/heads/${ref}`]);
  const remoteSha = onRemote ? onRemote.split(/\s+/)[0] : "";
  if (remoteSha !== sha) return { findings: [F("sha-not-on-remote", `origin/${ref} is ${remoteSha ? remoteSha.slice(0, 8) : "absent"}, candidate is ${sha.slice(0, 8)} — push the candidate branch first (the gate never pushes)`, ref)] };

  const tag = `${remote.tagPrefix || "predeploy/"}${sha}`;
  const list = () => {
    const r = gh(root, ["run", "list", "--workflow", workflow, "--event", "push", "--json", "databaseId,headSha,status,conclusion,createdAt,url", "-L", "30"]);
    if (r.status !== 0) return { error: r.err || r.out };
    try { return { runs: JSON.parse(r.out) }; } catch { return { error: "gh run list returned non-JSON" }; }
  };

  let l = list();
  if (l.error) return { findings: [F("gh-run-list-failed", l.error.slice(0, 300), workflow)] };
  let run = l.runs.find((x) => x.headSha === sha && x.status === "completed" && x.conclusion === "success");
  const reused = Boolean(run);
  if (!run) run = l.runs.find((x) => x.headSha === sha && x.status !== "completed");
  if (!run) {
    const started = Date.now();
    // A leftover tag from an earlier failed run would not re-trigger: delete it
    // first (a tag deletion fires no push workflow), then push it fresh.
    if (git(root, ["ls-remote", "origin", `refs/tags/${tag}`])) {
      const del = spawnSync("git", ["push", "origin", `:refs/tags/${tag}`], { cwd: root, encoding: "utf8", timeout: 120000 });
      if (del.status !== 0) return { findings: [F("trigger-tag-delete-failed", (del.stderr || "").slice(0, 300), tag)] };
    }
    const d = spawnSync("git", ["push", "origin", `${sha}:refs/tags/${tag}`], { cwd: root, encoding: "utf8", timeout: 120000 });
    if (d.status !== 0) return { findings: [F("trigger-tag-push-failed", (d.stderr || "").slice(0, 300), tag)] };
    for (let i = 0; i < 30 && !run; i++) {
      await sleep(4000);
      l = list();
      run = (l.runs || []).find((x) => x.headSha === sha && new Date(x.createdAt).getTime() >= started - 15000 && x.status !== "completed") || (l.runs || []).find((x) => x.headSha === sha && new Date(x.createdAt).getTime() >= started - 15000);
    }
    if (!run) return { findings: [F("workflow-run-not-found", "tag pushed but no run appeared for this sha", workflow)] };
  }

  const deadline = Date.now() + (remote.timeoutMin || 45) * 60000;
  let view;
  for (;;) {
    const v = gh(root, ["run", "view", String(run.databaseId), "--json", "status,conclusion,jobs,url,headSha"]);
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
