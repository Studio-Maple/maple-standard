/**
 * tools.mjs — the scanner tool catalog: how to find each tool, whether it
 * actually WORKS here (not merely exists on PATH), the Docker-image fallback,
 * and install commands for `predeploy doctor`.
 *
 * "Works" matters on the owner's machine: the scoop shim for trivy exists on
 * PATH but cannot create its process (Application Control), and native
 * semgrep cannot run on Windows at all (socketpair). So resolution runs
 * `<bin> <versionArgs>` and falls back to the pinned-by-name Docker image.
 */
import { spawnSync } from "node:child_process";
import { which } from "./lib.mjs";

/** @type {Record<string, {bin:string, version:string[], docker?:{image:string, entry?:string}, preferDocker?:boolean, install:Record<string,string>, note?:string}>} */
export const TOOLS = {
  gitleaks: {
    bin: "gitleaks", version: ["version"],
    docker: { image: "zricethezav/gitleaks:latest" },
    install: { winget: "winget install Gitleaks.Gitleaks", scoop: "scoop install gitleaks", docker: "docker pull zricethezav/gitleaks:latest" },
    note: "history scan needs a real git checkout, so native is strongly preferred over Docker in a worktree",
  },
  semgrep: {
    bin: "semgrep", version: ["--version"], preferDocker: true,
    docker: { image: "semgrep/semgrep:latest", entry: "semgrep" },
    install: { docker: "docker pull semgrep/semgrep:latest", wsl: "wsl: pip install semgrep (native Windows is unsupported: socketpair)" },
    note: "native semgrep cannot run on Windows; Docker is the supported path here",
  },
  "osv-scanner": {
    bin: "osv-scanner", version: ["--version"],
    docker: { image: "ghcr.io/google/osv-scanner:latest" },
    install: { scoop: "scoop install osv-scanner", winget: "winget install Google.OSVScanner", docker: "docker pull ghcr.io/google/osv-scanner:latest" },
  },
  trivy: {
    bin: "trivy", version: ["--version"],
    docker: { image: "aquasec/trivy:latest" },
    install: { winget: "winget install AquaSecurity.Trivy", docker: "docker pull aquasec/trivy:latest", scoop: "scoop install trivy (the shim can break under Application Control — prefer Docker)" },
    note: "the scoop shim for trivy is broken on this machine; the Docker image is the working path",
  },
  shellcheck: {
    bin: "shellcheck", version: ["--version"],
    docker: { image: "koalaman/shellcheck:stable" },
    install: { winget: "winget install koalaman.shellcheck", scoop: "scoop install shellcheck", docker: "docker pull koalaman/shellcheck:stable" },
  },
  actionlint: {
    bin: "actionlint", version: ["-version"],
    docker: { image: "rhysd/actionlint:latest" },
    install: { winget: "winget install rhysd.actionlint", scoop: "scoop install actionlint", docker: "docker pull rhysd/actionlint:latest" },
  },
  hadolint: {
    bin: "hadolint", version: ["--version"],
    docker: { image: "hadolint/hadolint:latest" },
    install: { winget: "winget install hadolint.hadolint", scoop: "scoop install hadolint", docker: "docker pull hadolint/hadolint:latest" },
  },
  checkov: {
    bin: "checkov", version: ["--version"], preferDocker: true,
    docker: { image: "bridgecrew/checkov:latest" },
    install: { pip: "pip install checkov", docker: "docker pull bridgecrew/checkov:latest" },
  },
  tflint: {
    bin: "tflint", version: ["--version"],
    docker: { image: "ghcr.io/terraform-linters/tflint:latest" },
    install: { winget: "winget install TerraformLinters.tflint", scoop: "scoop install tflint", docker: "docker pull ghcr.io/terraform-linters/tflint:latest" },
  },
  terraform: {
    bin: "terraform", version: ["version"],
    install: { winget: "winget install Hashicorp.Terraform", scoop: "scoop install terraform" },
  },
  zap: {
    bin: "zap.sh", version: ["-version"], preferDocker: true,
    docker: { image: "ghcr.io/zaproxy/zaproxy:stable" },
    install: { docker: "docker pull ghcr.io/zaproxy/zaproxy:stable" },
    note: "ZAP cannot start natively on this Windows host (JVM loopback selector fault); Docker is the supported path",
  },
  docker: {
    bin: "docker", version: ["version", "--format", "{{.Server.Version}}"],
    install: { winget: "winget install Docker.DockerDesktop" },
  },
  gh: {
    bin: "gh", version: ["--version"],
    install: { winget: "winget install GitHub.cli", scoop: "scoop install gh" },
  },
  snyk: {
    bin: "snyk", version: ["--version"],
    install: { npm: "npm i -g snyk" },
    note: "needs SNYK_TOKEN; the snyk preset reads it just-in-time from Windows Credential Manager into the child process env only (never `snyk auth`, which persists it in plaintext)",
  },
  node: { bin: "node", version: ["--version"], install: { winget: "winget install OpenJS.NodeJS.LTS" } },
  npm: { bin: "npm", version: ["--version"], install: { winget: "winget install OpenJS.NodeJS.LTS" } },
  git: { bin: "git", version: ["--version"], install: { winget: "winget install Git.Git" } },
};

function probe(bin, args) {
  const r = spawnSync(bin, args, { encoding: "utf8", timeout: 20000, shell: process.platform === "win32" && /^(npm|npx|snyk)$/.test(bin) });
  return r.status === 0 ? String(r.stdout || r.stderr).trim().split(/\r?\n/)[0] : null;
}

let dockerState; // undefined | {ok, detail}
export function dockerUsable() {
  if (dockerState) return dockerState;
  // Docker Desktop can take a while to answer under load (many containers, a busy gate run): retry before
  // concluding the daemon is down, because "unreachable" turns every Docker-backed scanner into tool-missing.
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], { encoding: "utf8", timeout: 60000 });
    if (r.status === 0 && String(r.stdout).trim()) return (dockerState = { ok: true, detail: String(r.stdout).trim() });
  }
  dockerState = { ok: false, detail: "docker daemon not reachable" };
  return dockerState;
}

export function dockerImagePresent(image) {
  return spawnSync("docker", ["image", "inspect", image], { encoding: "utf8", timeout: 30000 }).status === 0;
}

export function dockerPull(image) {
  const r = spawnSync("docker", ["pull", "--quiet", image], { encoding: "utf8", timeout: 20 * 60 * 1000 });
  return r.status === 0;
}

const cache = new Map();

/**
 * @returns {{name:string, mode:'native'|'docker'|'missing', version?:string, image?:string, bin?:string, reason?:string}}
 */
export function resolveTool(name, { allowDocker = true, pull = false } = {}) {
  const key = `${name}|${allowDocker}|${pull}`;
  if (cache.has(key)) return cache.get(key);
  const t = TOOLS[name];
  let out;
  if (!t) out = { name, mode: "missing", reason: `unknown tool "${name}"` };
  else {
    const nativeVersion = !t.preferDocker || !t.docker || !allowDocker ? (which(t.bin) ? probe(t.bin, t.version) : null) : null;
    if (nativeVersion) out = { name, mode: "native", version: nativeVersion, bin: t.bin };
    else if (t.docker && allowDocker && dockerUsable().ok) {
      const have = dockerImagePresent(t.docker.image) || (pull && dockerPull(t.docker.image));
      out = have ? { name, mode: "docker", image: t.docker.image, entry: t.docker.entry } : { name, mode: "missing", reason: `Docker image ${t.docker.image} not present (run: predeploy doctor --pull)` };
    } else {
      const found = which(t.bin);
      out = { name, mode: "missing", reason: found ? `${t.bin} is on PATH (${found}) but does not run` : `${t.bin} not installed` };
    }
  }
  cache.set(key, out);
  return out;
}

export function installHints(name) {
  const t = TOOLS[name];
  return t ? Object.values(t.install).join("  |  ") : "";
}

/** Windows path for `docker -v`: C:/dir/sub (forward slashes), POSIX paths untouched. */
export function nativePath(p) {
  let s = String(p).replace(/\\/g, "/");
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(s);
  if (process.platform === "win32" && m) s = `${m[1].toUpperCase()}:/${m[2]}`;
  return s;
}

export function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** Build a `docker run` command string (bash-safe; MSYS path conversion disabled). */
export function dockerRunCmd(image, { mounts = [], env = [], workdir, entrypoint, args = "" } = {}) {
  const parts = ["MSYS_NO_PATHCONV=1", "docker", "run", "--rm"];
  for (const [host, cont, mode] of mounts) parts.push("-v", shq(`${nativePath(host)}:${cont}${mode === "ro" ? ":ro" : ""}`));
  for (const e of env) parts.push("-e", shq(e));
  if (workdir) parts.push("-w", shq(workdir));
  if (entrypoint !== undefined) parts.push("--entrypoint", shq(entrypoint));
  parts.push(shq(image));
  return parts.join(" ") + (args ? " " + args : "");
}
