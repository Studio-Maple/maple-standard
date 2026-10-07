/**
 * ci-stack-docker.mjs - the Docker side of the isolated CI stack (D071): everything is addressed by the Supabase CLI's
 * project label, and every object is re-verified to carry EXACTLY the CI project's label before it is touched, so a
 * bug (or a CI id that is a prefix/suffix of a dev id) can never reach the dev stack's containers, networks or volumes.
 */
import { spawnSync } from "node:child_process";
import net from "node:net";
import { RefusalError } from "./ci-stack-config.mjs";

export const LABEL_KEY = "com.supabase.cli.project";
export const labelFilter = (projectId) => `label=${LABEL_KEY}=${projectId}`;

export function dockerRun(args, run = spawnSync) {
  return run("docker", args, { encoding: "utf8", timeout: 300_000 });
}

const KINDS = {
  container: { list: ["ps", "-a"], rm: ["rm", "-f", "-v"] },
  volume: { list: ["volume", "ls"], rm: ["volume", "rm", "-f"] },
  network: { list: ["network", "ls"], rm: ["network", "rm"] },
};

/** [{id, label}] of `kind` carrying the project label (the label is read back per row, not trusted from the filter). */
export function listLabelled(docker, kind, projectId) {
  const id = kind === "volume" ? "{{.Name}}" : "{{.ID}}";
  const r = docker([...KINDS[kind].list, "--filter", labelFilter(projectId), "--format", `${id} {{.Label "${LABEL_KEY}"}}`]);
  if (r.status !== 0) return [];
  return String(r.stdout).split(/\r?\n/).map((l) => l.trim().split(" ")).filter((p) => p[0]).map(([oid, label]) => ({ id: oid, label: label ?? "" }));
}

/** Names of the project's containers (for logs/status). */
export function containerNames(docker, projectId) {
  const r = docker(["ps", "-a", "--filter", labelFilter(projectId), "--format", `{{.Names}} {{.Label "${LABEL_KEY}"}}`]);
  if (r.status !== 0) return [];
  return String(r.stdout).split(/\r?\n/).map((l) => l.trim().split(" ")).filter((p) => p[0] && p[1] === projectId).map((p) => p[0]);
}

/** D052: containers carry restart:unless-stopped; strip it so Docker Desktop never resurrects the stack at boot. */
export function stripRestartPolicies(docker, projectId, log = () => {}) {
  const ids = listLabelled(docker, "container", projectId).filter((o) => o.label === projectId).map((o) => o.id);
  if (ids.length === 0) return;
  if (docker(["update", "--restart=no", ...ids]).status !== 0) log(`warning: could not clear the restart policy of ${ids.length} container(s)`);
}

/**
 * Remove every container, then volume, then network labelled with the CI project id. Each object is refused unless its label equals
 * the CI id exactly. Returns {removed, failed} counts; a leftover is reported, never ignored.
 */
export function removeProjectObjects(docker, projectId, log = () => {}) {
  if (!projectId) throw new RefusalError("no CI project id: refusing to remove docker objects");
  let removed = 0;
  let failed = 0;
  for (const kind of ["container", "volume", "network"]) {
    for (const o of listLabelled(docker, kind, projectId)) {
      if (o.label !== projectId) throw new RefusalError(`refusing to remove ${kind} ${o.id}: it carries project label "${o.label}", not "${projectId}"`);
      const r = docker([...KINDS[kind].rm, o.id]);
      if (r.status === 0) removed++;
      else { failed++; log(`warning: could not remove ${kind} ${o.id}`); }
    }
  }
  return { removed, failed };
}

/** Anything still labelled with the project id (containers/volumes/networks), for the post-down assertion. */
export function leftovers(docker, projectId) {
  return ["container", "volume", "network"].flatMap((k) => listLabelled(docker, k, projectId).map((o) => `${k}:${o.id}`));
}

// ---- host port probes ------------------------------------------------------
function tryListen(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once("error", (e) => res(e.code || "ERR"));
    s.listen(port, "127.0.0.1", () => s.close(() => res(null)));
  });
}

/** Ports with a LISTENING socket (Windows netstat); null where the platform has no cheap answer. */
export function listeningPorts(run = spawnSync, platform = process.platform) {
  if (platform !== "win32") return null;
  const r = run("netstat", ["-ano"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const ports = new Set();
  for (const line of String(r.stdout).split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+\d+/.exec(line);
    if (m) ports.add(Number(m[1]));
  }
  return ports;
}

/**
 * [{port, code}] of `ports` that cannot be used: a loopback bind fails (EACCES = excluded range, EADDRINUSE = taken), or something
 * listens on it (Docker binds 0.0.0.0, which a loopback bind test alone can miss).
 */
export async function busyPorts(ports, { listen = tryListen, listening = listeningPorts } = {}) {
  const held = listening();
  const bad = [];
  for (const port of ports) {
    const code = await listen(port);
    if (code) bad.push({ port, code });
    else if (held?.has(port)) bad.push({ port, code: "LISTENING" });
  }
  return bad;
}

/** Can the Docker daemon be used? A loaded Docker Desktop answers `docker info` in 10-60 s, so the timeout is generous. */
export function dockerUsable(run = spawnSync) {
  const r = run("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore", timeout: 180_000 });
  return r.status === 0 && !r.error;
}
