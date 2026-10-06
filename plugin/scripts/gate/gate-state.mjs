/**
 * gate-state.mjs - everything the D066 gate persists, under <git-common-dir>/maple
 * (shared by every worktree of the clone, never committed):
 *
 *   gate-debt.jsonl      append-only ledger of gate steps that were skipped for a LISTED reason
 *                        (debt lines {sha, branch, step, reason, at, who, ref?}) and of the green
 *                        heavy runs that paid them (paid lines {paid:true, sha, step, by, at})
 *   heavy-pass/<sha>.json  "the full heavy tier was green on exactly this commit" (production
 *                        promotion requires it for HEAD)
 *   heavy-runs/          reports + logs of scheduled heavy runs (heavy-run.mjs)
 *
 * Zero dependencies. A skip is only ever a record of work NOT done, so the ledger is
 * conservative by construction: more debt can only block, never allow.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Listed skip reasons: the only values MAPLE_GATE_SKIP accepts, with the step each may skip. */
export const SKIP_REASONS = {
  "docker-unavailable": { steps: ["live"], why: "Docker or the stack's ports cannot be used on this machine" },
  "registry-unreachable": { steps: ["dep-freshness"], why: "the npm registry cannot be reached" },
};

export function git(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

/** <git-common-dir>/maple (created). Throws outside a git repo. */
export function mapleDir(root) {
  const common = git(root, ["rev-parse", "--git-common-dir"]);
  if (!common) throw new Error("not a git repository: " + root);
  const dir = join(isAbsolute(common) ? common : resolve(root, common), "maple");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const sub = (root, name) => {
  const d = join(mapleDir(root), name);
  mkdirSync(d, { recursive: true });
  return d;
};

const nowIso = () => new Date().toISOString();
export const who = () => process.env.CLAUDE_SESSION_NAME || `${process.env.USERNAME || process.env.USER || os.userInfo().username}@${os.hostname()}`;

const debtFile = (root) => join(mapleDir(root), "gate-debt.jsonl");

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** commit `a` is `b` or an ancestor of `b` (false when either is unknown to this repo). */
export function isAncestorOrSame(root, a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const r = spawnSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: root, stdio: "ignore" });
  return r.status === 0;
}

const resolveSha = (root, ref) => git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);

// ── reasons ─────────────────────────────────────────────────────────────────
export function validateSkip({ reason, step }) {
  if (!reason) return { ok: false, error: "MAPLE_GATE_SKIP needs a reason. Allowed: " + Object.keys(SKIP_REASONS).join(", ") };
  const def = SKIP_REASONS[reason];
  if (!def) return { ok: false, error: `unknown MAPLE_GATE_SKIP reason '${reason}'. Allowed: ${Object.keys(SKIP_REASONS).join(", ")}` };
  if (step && !def.steps.includes(step)) return { ok: false, error: `reason '${reason}' cannot skip step '${step}' (it covers: ${def.steps.join(", ")})` };
  return { ok: true };
}

/** Can a Docker daemon be used? (`docker info` exits 0.) Injectable for tests. */
export function dockerWorks(run = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore", timeout: 20000 })) {
  const r = run("docker", ["info"]);
  return r.status === 0 && !r.error;
}

/** Ports the supabase config binds on 127.0.0.1 */
export function stackPorts(root) {
  const f = join(root, "supabase", "config.toml");
  if (!existsSync(f)) return [];
  const ports = new Set();
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:[a-z_]*port)\s*=\s*(\d+)/i.exec(line);
    if (m) ports.add(Number(m[1]));
  }
  return [...ports];
}

/** Resolve with the ports that cannot be bound (EACCES: reserved range; EADDRINUSE: taken). */
export async function unbindablePorts(ports, listen = tryListen) {
  const bad = [];
  for (const p of ports) {
    const r = await listen(p);
    if (r) bad.push({ port: p, code: r });
  }
  return bad;
}

function tryListen(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once("error", (e) => res(e.code || "ERR"));
    s.listen(port, "127.0.0.1", () => s.close(() => res(null)));
  });
}

/** The registry answers a HEAD request within 8 s. Injectable for tests. */
export async function registryReachable(fetchImpl = fetch, url = (process.env.npm_config_registry || "https://registry.npmjs.org").replace(/\/+$/, "") + "/") {
  try {
    const r = await fetchImpl(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

/**
 * Is the claimed reason actually true on this machine? A skip is a gate pass without running the
 * step, so it is only honoured when running the step was genuinely impossible.
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function verifyReason(root, reason, deps = {}) {
  if (reason === "docker-unavailable") {
    if (!(deps.dockerWorks ?? dockerWorks)()) return { ok: true, detail: "`docker info` fails" };
    const bad = await unbindablePorts(stackPorts(root), deps.listen);
    if (bad.length) return { ok: true, detail: `stack ports unbindable: ${bad.map((b) => `${b.port} (${b.code})`).join(", ")}` };
    return { ok: false, detail: "Docker works and every stack port is bindable - run the step, do not skip it" };
  }
  if (reason === "registry-unreachable") {
    if (await (deps.registryReachable ?? registryReachable)()) return { ok: false, detail: "the registry is reachable - run the step, do not skip it" };
    return { ok: true, detail: "the registry does not answer" };
  }
  return { ok: false, detail: "unknown reason" };
}

// ── debt ledger ─────────────────────────────────────────────────────────────
/** Append a debt entry. Unverified on purpose: recording debt can only add blockers. */
export function recordDebt(root, { sha, branch, step, reason, ref, by }) {
  const entry = {
    sha: sha || git(root, ["rev-parse", "HEAD"]),
    branch: branch ?? git(root, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "?",
    step,
    reason,
    at: nowIso(),
    who: by || who(),
    ...(ref ? { ref } : {}),
  };
  if (!entry.sha || !step || !reason) throw new Error("recordDebt needs sha, step and reason");
  appendFileSync(debtFile(root), JSON.stringify(entry) + "\n");
  return entry;
}

/** @returns {{debts:object[], paid:Set<string>}} paid keys are `${sha}|${step}|${at}` of the debt line. */
export function readDebt(root) {
  const lines = readLines(debtFile(root));
  const debts = lines.filter((l) => !l.paid);
  const paid = new Set(lines.filter((l) => l.paid).map((l) => l.of));
  return { debts, paid };
}

const key = (d) => `${d.sha}|${d.step}|${d.at}`;

/** Unpaid debts; with `head`, only those whose commit is in HEAD's history. */
export function unpaidDebt(root, { head } = {}) {
  const { debts, paid } = readDebt(root);
  return debts.filter((d) => !paid.has(key(d)) && (!head || isAncestorOrSame(root, d.sha, head)));
}

/** A green heavy run on `heavySha` pays every unpaid debt whose commit it contains. */
export function payDebt(root, heavySha) {
  const settled = [];
  for (const d of unpaidDebt(root)) {
    if (!isAncestorOrSame(root, d.sha, heavySha)) continue;
    appendFileSync(debtFile(root), JSON.stringify({ paid: true, of: key(d), sha: d.sha, step: d.step, by: heavySha, at: nowIso() }) + "\n");
    settled.push(d);
  }
  return settled;
}

// ── heavy-pass stamps ───────────────────────────────────────────────────────
export const heavyStampPath = (root, sha) => join(sub(root, "heavy-pass"), `${sha}.json`);

export function writeHeavyStamp(root, sha, extra = {}) {
  const target = heavyStampPath(root, sha);
  const rec = { sha, tree: git(root, ["rev-parse", `${sha}^{tree}`]), tier: "heavy", at: nowIso(), who: who(), ...extra };
  const tmp = target + `.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n");
  renameSync(tmp, target);
  return rec;
}

export function readHeavyStamp(root, sha) {
  try {
    return JSON.parse(readFileSync(heavyStampPath(root, sha), "utf8"));
  } catch {
    return null;
  }
}

/** Most recent heavy-stamped ancestor of `head` (the baseline of "what changed since the last heavy"). */
export function lastHeavyBase(root, head) {
  const dir = sub(root, "heavy-pass");
  const out = git(root, ["rev-list", "--max-count=2000", head]);
  if (!out) return null;
  for (const sha of out.split(/\r?\n/)) if (existsSync(join(dir, `${sha}.json`))) return sha;
  return null;
}

/**
 * Production promotion requirement (D066): a green heavy run on exactly `sha`, and zero unpaid gate
 * debt among the commits `sha` contains.
 * @returns {{ok:boolean, reason:string}}
 */
export function verifyPromotion(root, sha) {
  const stamp = readHeavyStamp(root, sha);
  if (!stamp || stamp.sha !== sha) {
    return { ok: false, reason: `no green heavy run for HEAD ${sha.slice(0, 8)} - run \`pnpm ci:heavy\` (or wait for the scheduled heavy run, node <plugin>/scripts/gate/heavy-run.mjs) on this exact commit` };
  }
  const debt = unpaidDebt(root, { head: sha });
  if (debt.length) {
    const d = debt[0];
    return { ok: false, reason: `${debt.length} unpaid gate debt entr${debt.length === 1 ? "y" : "ies"} in HEAD's history (first: ${d.sha.slice(0, 8)} step ${d.step}, ${d.reason}${d.ref ? ", " + d.ref : ""}) - a green full heavy run on a commit containing ${debt.length === 1 ? "it" : "them"} pays the debt` };
  }
  return { ok: true, reason: `green heavy run for ${sha.slice(0, 8)} at ${stamp.at}, no unpaid gate debt` };
}

export { resolveSha, nowIso };
