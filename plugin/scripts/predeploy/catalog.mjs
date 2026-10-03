/**
 * catalog.mjs — built-in presets for `predeploy.checks[].preset`.
 *
 * A preset is either
 *   build(options, ctx) -> { command, reports?, parse, cwd?: "scan"|"root", env? }   (a shell command + a parser)
 *   run(options, ctx)   -> Promise<{ findings, notes? }>                               (pure-JS check, see internal.mjs)
 *
 * Every file-based scanner runs against `ctx.scanRoot`: a clean `git archive`
 * export of the candidate SHA. That is deliberate — it scans exactly what a
 * deploy would ship (no node_modules, no untracked junk, no sibling
 * worktrees nested in the checkout) and it makes the result independent of
 * whatever happens to be on the developer's disk.
 *
 * Suppression sources a tool would honour silently (`.trivyignore`,
 * `osv-scanner.toml`, `nosemgrep`, ...) are disabled via flags where the tool
 * allows it, and caught by the `suppression-audit` preset where it does not.
 * The ONLY sanctioned exception mechanism is the expiring allowlist file.
 */
import { resolveTool, dockerRunCmd, shq, TOOLS } from "./tools.mjs";
import { INTERNAL_PRESETS } from "./internal.mjs";

export class ToolMissing extends Error {
  constructor(tool, reason) {
    super(reason);
    this.tool = tool;
  }
}

/** Resolve a tool or throw ToolMissing. */
export function needTool(ctx, name) {
  const t = resolveTool(name, { allowDocker: ctx.docker, pull: ctx.pull });
  if (t.mode === "missing") throw new ToolMissing(name, t.reason);
  return t;
}

/**
 * Build the shell command that runs `toolName` with the args produced by
 * argsFn(P). P.src is the scan root as seen by the tool ("." in both modes),
 * P.out the report directory as seen by the tool.
 */
export function invoke(ctx, toolName, argsFn, { env = [] } = {}) {
  const t = needTool(ctx, toolName);
  if (t.mode === "native") return `${shq(t.bin)} ${argsFn({ src: ".", out: shq(ctx.outDirPosix) })}`;
  const P = { src: ".", out: "/out" };
  const entry = t.entry ? `${t.entry} ` : "";
  return dockerRunCmd(t.image, {
    mounts: [[ctx.scanRoot, "/src", "ro"], [ctx.outDir, "/out", "rw"]],
    workdir: "/src",
    env,
    args: entry + argsFn(P),
  });
}

const DEFAULT_EXCLUDE_DIRS = ["node_modules", "dist", "build", ".next", ".wrangler", "coverage", ".worktrees"];

/**
 * semgrep scan arguments. `options.timeout` (whole seconds, optional) is semgrep's per-rule, per-file
 * `--timeout`; unset keeps semgrep's own default (5 s). A timed-out rule is reported by semgrep as a scanner
 * error, which the gate counts as a finding, so a big file on a loaded box can fail the gate on speed alone.
 * Raising the limit is configuration, not a suppression: every rule still runs to completion on every file.
 */
export function semgrepArgs(o, P) {
  const timeout = Number.isInteger(o.timeout) && o.timeout > 0 ? ` --timeout ${o.timeout}` : "";
  return `scan ${o.configs.map((c) => `--config ${shq(c)}`).join(" ")} ${o.exclude.map((e) => `--exclude ${shq(e)}`).join(" ")}${timeout} --disable-nosem --metrics=off --quiet --json -o ${P.out}/semgrep.json ${P.src}`;
}

const q = (xs) => xs.map(shq).join(" ");
const scoped = (o, xs, key = (x) => x) => xs.filter((x) => !(o.exclude || []).some((p) => key(x).startsWith(p)));

const COMMAND_PRESETS = {
  gitleaks: {
    describe: "Secrets in the working tree and the entire git history (all branches). Inline `gitleaks:allow` is ignored.",
    tools: ["gitleaks"],
    build(o, ctx) {
      const cfg = o.config ? `--config ${shq(o.config)}` : "";
      // cd into the scan copy and scan `.`: with an absolute --source gitleaks reports ABSOLUTE file paths, so every path-anchored
      // allowlist (`^app/src/x.test.ts$`) silently never matched and the gate flagged fixtures the repo's own scan accepts.
      const tree = `( cd ${shq(ctx.scanRootPosix)} && gitleaks detect --source . --no-git --redact --ignore-gitleaks-allow ${cfg} --exit-code 0 --report-format json --report-path ${shq(ctx.outDirPosix + "/gitleaks-tree.json")} )`;
      const hist = `gitleaks detect --source ${shq(ctx.rootPosix)} --log-opts=--all --redact --ignore-gitleaks-allow ${cfg} --exit-code 0 --report-format json --report-path ${shq(ctx.outDirPosix + "/gitleaks-history.json")}`;
      const t = needTool(ctx, "gitleaks");
      if (t.mode !== "native") throw new ToolMissing("gitleaks", "gitleaks must run natively (history scan needs the real git checkout)");
      const reports = ["gitleaks-tree.json"].concat(o.history === false ? [] : ["gitleaks-history.json"]);
      return { command: o.history === false ? tree : `${tree} ; ${hist}`, reports, parse: "gitleaks-json", cwd: "root" };
    },
  },

  semgrep: {
    describe: "SAST. Every severity (INFO/WARNING/ERROR) counts; `nosemgrep` comments are ignored (--disable-nosem).",
    tools: ["semgrep"],
    build(o, ctx) {
      const configs = o.configs || ["p/typescript", "p/owasp-top-ten", "p/nodejs", "p/secrets", "p/javascript"];
      const ex = o.exclude || DEFAULT_EXCLUDE_DIRS;
      const command = invoke(ctx, "semgrep", (P) => semgrepArgs({ ...o, configs, exclude: ex }, P));
      return { command, reports: ["semgrep.json"], parse: "semgrep-json", cwd: "scan", env: { SEMGREP_SEND_METRICS: "off" } };
    },
  },

  "osv-scanner": {
    describe: "Known-vulnerable dependencies from every tracked lockfile (dev dependencies included). osv-scanner.toml ignores are NOT honoured.",
    tools: ["osv-scanner"],
    build(o, ctx) {
      const locks = scoped(o, ctx.listFiles(/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|poetry\.lock|Pipfile\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|composer\.lock)$/));
      if (!locks.length) return { command: "echo 'no lockfiles tracked' >&2; exit 0", reports: [], parse: "exit-code", cwd: "scan" };
      const command = invoke(ctx, "osv-scanner", (P) =>
        `scan source --config ${P.out}/empty.toml ${locks.map((l) => `-L ${shq(l)}`).join(" ")} --format json --output-file ${P.out}/osv.json`);
      return { command, reports: ["osv.json"], parse: "osv-json", cwd: "scan", emptyFiles: ["empty.toml"] };
    },
  },

  "npm-audit": {
    describe: "npm audit for every lockfile directory, all severities, dev dependencies included.",
    tools: ["npm"],
    build(o, ctx) {
      const dirs = o.dirs || scoped(o, ctx.lockDirs(), (d) => d + "/");
      const reports = [];
      const cmds = dirs.map((d) => {
        const name = `npm-audit-${d === "." ? "root" : d.replace(/[^A-Za-z0-9]+/g, "_")}.json`;
        reports.push(name);
        return `( cd ${shq(d)} && npm audit --json --audit-level=info > ${shq(ctx.outDirPosix + "/" + name)} )`;
      });
      return { command: cmds.join(" ; "), reports, parse: "npm-audit-json", cwd: "scan" };
    },
  },

  "trivy-fs": {
    describe: "Trivy filesystem scan: vulnerabilities (incl. dev deps), secrets, IaC/Dockerfile misconfig. .trivyignore is NOT honoured.",
    tools: ["trivy"],
    build(o, ctx) {
      const scanners = (o.scanners || ["vuln", "secret", "misconfig"]).join(",");
      const skip = (o.skipDirs || []).map((d) => `--skip-dirs ${shq(d)}`).join(" ");
      const command = invoke(ctx, "trivy", (P) =>
        `fs --scanners ${scanners} --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL --include-dev-deps --ignorefile ${P.out}/empty.ignore ${skip} --exit-code 0 --quiet --format json -o ${P.out}/trivy-fs.json ${P.src}`);
      return { command, reports: ["trivy-fs.json"], parse: "trivy-json", cwd: "scan", emptyFiles: ["empty.ignore"] };
    },
  },

  shellcheck: {
    describe: "shellcheck at --severity=style over every tracked *.sh. .shellcheckrc is not read (--norc).",
    tools: ["shellcheck"],
    build(o, ctx) {
      const files = scoped(o, ctx.listFiles(/\.(sh|bash)$/));
      if (!files.length) return { command: "true", reports: [], parse: "exit-code", cwd: "scan" };
      const command = invoke(ctx, "shellcheck", (P) => `--norc -x --severity=style --format=json1 ${q(files)} > ${P.out}/shellcheck.json`);
      return { command: wrapRedirect(ctx, command, "shellcheck.json"), reports: ["shellcheck.json"], parse: "shellcheck-json", cwd: "scan" };
    },
  },

  actionlint: {
    describe: "actionlint over every tracked workflow file.",
    tools: ["actionlint"],
    build(o, ctx) {
      const files = ctx.listFiles(/^\.github\/workflows\/[^/]+\.ya?ml$/);
      if (!files.length) return { command: "true", reports: [], parse: "exit-code", cwd: "scan" };
      const command = invoke(ctx, "actionlint", (P) => `-config-file ${P.out}/empty.yaml -no-color -format '{{json .}}' ${q(files)}`);
      return { command, parse: "actionlint-json", cwd: "scan", emptyFiles: ["empty.yaml"] };
    },
  },

  checkov: {
    describe: "checkov over Terraform, Dockerfiles and GitHub Actions. Repo .checkov.yaml/.baseline files are deleted from the scan copy (checkov auto-loads .checkov.yaml even with --config-file) and an empty `{}` config is passed; inline checkov:skip is caught by suppression-audit.",
    tools: ["checkov"],
    build(o, ctx) {
      const dirs = o.dirs || ["."];
      const frameworks = (o.frameworks || ["terraform", "dockerfile", "github_actions"]).join(" ");
      const command = invoke(ctx, "checkov", (P) =>
        `${dirs.map((d) => `-d ${shq(d)}`).join(" ")} --framework ${frameworks} --config-file ${P.out}/empty.yaml --skip-path node_modules --skip-path local-dev/node_modules --compact --quiet -o json --output-file-path ${P.out} ; true`, { env: ["PYTHONUTF8=1"] });
      return { command: `PYTHONUTF8=1 ${command}`, reports: ["results_json.json"], parse: "checkov-json", cwd: "scan", emptyFiles: ["empty.yaml"] };
    },
  },

  tflint: {
    describe: "tflint --recursive over the Terraform tree (core ruleset unless a config is given).",
    tools: ["tflint"],
    build(o, ctx) {
      const cfg = o.config ? `--config ${shq(o.config)}` : "";
      const command = invoke(ctx, "tflint", (P) => `--recursive --call-module-type=none ${cfg} --format json --chdir ${P.src} ; true`);
      return { command, parse: "tflint-json", cwd: "scan" };
    },
  },
};

/** Wrap: the redirect inside invoke() targets the container path; for native runs redirect to the real file. Docker mode redirects on the host instead. */
function wrapRedirect(ctx, command, name) {
  // In docker mode "> /out/<name>" would be interpreted by the HOST shell (no such dir), so
  // retarget it to the host path; native mode already wrote host paths.
  return command.replace(` > /out/${name}`, ` > ${shq(ctx.outDirPosix + "/" + name)}`);
}

export const PRESETS = {
  ...COMMAND_PRESETS,
  ...INTERNAL_PRESETS,
};

export const PRESET_NAMES = Object.keys(PRESETS);

export function presetTools(name) {
  const p = PRESETS[name];
  return p ? p.tools || [] : [];
}

export function describePreset(name) {
  return PRESETS[name]?.describe || "";
}

export { TOOLS };
