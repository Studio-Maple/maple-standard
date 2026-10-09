// link-guard (D012 follow-up): never install into, or recursively delete through, a LINKED node_modules.
//
// maple-start junction-links (symlinks on Unix) each worktrees.nodeModulesDirs entry's node_modules
// to the MAIN checkout's. Anything that rewrites that directory's contents from inside the worktree
// rewrites the main checkout's install:
//   - `npm ci` deletes every entry of ./node_modules BEFORE installing (lib/commands/ci.js readdir + rm)
//     — through a junction that empties the main checkout's packages; an interrupted or failed run
//     leaves it empty. EasyCaller 2026-10-09: main's site/node_modules found with 0 entries after
//     agents ran `(cd site && npm ci)` in worktrees whose site/node_modules was such a junction.
//   - `npm install|add|remove|update|prune|dedupe` (and the pnpm/yarn/bun equivalents) reify into it.
//   - `rm -r`, `Remove-Item -Recurse`, `rmdir /s`, `rimraf` on a path UNDER the link (or `link/*`,
//     `link/`) delete the main checkout's files; on the link itself the safe tool is a plain
//     `rmdir` (cmd) / `rm` (no -r), which removes only the reparse point.
// The guard lstat()s only the node_modules paths a command would touch (no child process).
//
// maple.config.json hooks.bashGuard.linkGuardEnabled (default true).
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsPath, isDataOnly, normPath } from "./shell.mjs";

const PMS = new Set(["npm", "pnpm", "yarn", "bun"]);
// Subcommands that reify into (or empty) node_modules. Aliases included; npm accepts typo aliases too.
const WRITES = {
  npm: ["ci", "clean-install", "ic", "install-clean", "isntall-clean", "install-ci-test", "cit", "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "install-test", "it", "uninstall", "unlink", "un", "remove", "rm", "r", "update", "up", "upgrade", "udpate", "prune", "dedupe", "ddp", "link", "ln"],
  pnpm: ["install", "i", "add", "remove", "rm", "uninstall", "un", "update", "up", "upgrade", "prune", "dedupe", "import", "link", "ln", "unlink"],
  yarn: ["install", "add", "remove", "upgrade", "up", "dedupe", "link", "unlink"],
  bun: ["install", "i", "add", "a", "remove", "rm", "update", "link", "unlink"],
};
const VALUE_FLAGS = new Set(["--prefix", "-C", "--dir", "--cwd", "-w", "--workspace", "--filter", "-F", "--loglevel", "--registry", "--cache", "--userconfig"]);
const DIR_FLAGS = new Set(["--prefix", "-C", "--dir", "--cwd"]);
const RM_VERBS = new Set(["rm", "remove-item", "ri", "del", "erase", "rd", "rmdir", "rimraf"]);

const join = (base, p) => (isAbsPath(p) ? normPath(p) : normPath(`${base}/${p}`));

function isLink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}
function targetOf(p) {
  try { return realpathSync.native(p); } catch { return "(unresolvable)"; }
}
const winPath = (p) => (/^[a-z]:\//i.test(p) ? p.replace(/\//g, "\\") : p);

/** The directory a segment runs in: `cd` earlier in the command (absolute or relative to cwd), else cwd. */
function baseDir(seg, cwd) {
  if (!seg.cd) return normPath(cwd);
  return isAbsPath(seg.cd) || /^[a-z]:/i.test(seg.cd) ? normPath(seg.cd) : join(cwd, seg.cd);
}

/** Workspace member dirs (literal entries and one trailing `/*`) of a project root; pnpm-workspace.yaml too. */
function workspaceDirs(root) {
  const pats = [];
  try {
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    if (Array.isArray(ws)) pats.push(...ws);
  } catch { /* no package.json / not JSON: no workspaces */ }
  try {
    const y = readFileSync(`${root}/pnpm-workspace.yaml`, "utf8");
    for (const m of y.matchAll(/^\s*-\s*["']?([^"'#\n]+?)["']?\s*$/gm)) pats.push(m[1]);
  } catch { /* none */ }
  const out = [];
  for (const raw of pats) {
    const p = String(raw).replace(/^\.\//, "").replace(/\/$/, "");
    if (p.startsWith("!")) continue;
    if (/^[^*?[]+\/\*$/.test(p)) {
      const parent = `${root}/${p.slice(0, -2)}`;
      try { for (const d of readdirSync(parent, { withFileTypes: true })) if (d.isDirectory() && d.name !== "node_modules") out.push(`${parent}/${d.name}`); } catch { /* missing */ }
    } else if (!/[*?[]/.test(p)) out.push(`${root}/${p}`);
  }
  return out;
}

/** For a package-manager segment that writes node_modules: the dir it installs in, else null. */
function installDir(seg, base) {
  if (!PMS.has(seg.verb)) return null;
  const a = seg.args.map((w) => w.text);
  let dir = base;
  let sub = null;
  for (let n = 0; n < a.length; n++) {
    const t = a[n];
    const eq = t.indexOf("=");
    const flag = eq > 0 ? t.slice(0, eq) : t;
    if (flag === "-g" || flag === "--global" || (flag === "--location" && t.endsWith("global"))) return null;
    if (DIR_FLAGS.has(flag)) { dir = join(base, eq > 0 ? t.slice(eq + 1) : a[++n] ?? "."); continue; }
    if (VALUE_FLAGS.has(t)) { n++; continue; }
    if (t.startsWith("-")) continue;
    if (sub === null) sub = t.toLowerCase();
  }
  if (sub === null) return seg.verb === "yarn" ? dir : null; // bare `yarn` installs; bare npm/pnpm/bun print help
  return WRITES[seg.verb].includes(sub) ? dir : null;
}

/** Linked node_modules an install in `dir` would rewrite: its own, plus its workspace members'. */
function linkedInstallTargets(dir) {
  const hits = [];
  for (const d of [dir, ...workspaceDirs(dir)]) {
    const nm = `${d}/node_modules`;
    if (isLink(nm)) hits.push(nm);
  }
  return hits;
}

/** Recursive-delete segments: { targets: string[] } with paths resolved, else null. */
function recursiveDelete(seg, base) {
  let verb = seg.verb;
  let words = seg.args.map((w) => w.text);
  if (verb === "cmd") { // cmd /c rmdir /s /q x
    const i = words.findIndex((w) => /^\/{1,2}[ck]$/i.test(w));
    if (i < 0) return null;
    words = words.slice(i + 1);
    verb = (words.shift() ?? "").toLowerCase();
  }
  if (verb === "npx" || verb === "pnpx" || verb === "bunx") {
    const i = words.findIndex((w) => !w.startsWith("-"));
    if (i < 0 || !/^rimraf(@.*)?$/.test(words[i])) return null;
    verb = "rimraf";
    words = words.slice(i + 1);
  }
  if (!RM_VERBS.has(verb)) return null;
  let recursive = verb === "rimraf";
  const targets = [];
  for (const w of words) {
    if (/^--recursive$/i.test(w) || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(w) && !/^-(force|fo?)$/i.test(w) || /^-recurse$/i.test(w) || /^\/s$/i.test(w)) { recursive = true; continue; }
    if (/^-(path|literalpath|lp)$/i.test(w)) continue;
    if (w.startsWith("-") || /^\/[a-z]$/i.test(w)) continue;
    targets.push(w);
  }
  if (!recursive || !targets.length) return null;
  return targets.map((t) => ({ raw: t, path: join(base, t) }));
}

/** Does deleting `t` recurse through a linked node_modules? Returns the link path or null. */
function throughLink(t) {
  // keep the part before the first glob segment; a glob anywhere means "contents of"
  const segs = t.path.split("/");
  const g = segs.findIndex((s) => /[*?[]/.test(s));
  const fixed = g < 0 ? segs : segs.slice(0, g);
  const under = g >= 0 || /[\\/](\.)?$/.test(t.raw);
  for (let n = 1; n <= fixed.length; n++) {
    if (fixed[n - 1] !== "node_modules") continue;
    const p = fixed.slice(0, n).join("/") || "/";
    if (!isLink(p)) continue;
    if (n < fixed.length || under) return { link: p, onLink: false };
    return { link: p, onLink: true };
  }
  return null;
}

export function check(ctx) {
  const cfg = ctx.config().cfg?.hooks?.bashGuard ?? {};
  if (cfg.linkGuardEnabled === false) return undefined;
  for (const seg of ctx.segments()) {
    if (isDataOnly(seg)) continue;
    const base = baseDir(seg, ctx.cwd);
    const dir = installDir(seg, base);
    if (dir) {
      const hits = linkedInstallTargets(dir);
      if (hits.length) {
        const nm = hits[0];
        const tgt = targetOf(nm);
        return {
          deny:
            `BLOCKED (link-guard): ${nm} is a link to ${tgt} — another checkout's install (worktrees link node_modules from the main ` +
            `checkout). \`${seg.verb} ${seg.args.map((w) => w.text).join(" ")}\` rewrites that directory; \`npm ci\` first DELETES every entry ` +
            "in it, so it would empty the main checkout's packages through the link (EasyCaller 2026-10-09: main's site/node_modules wiped).\n" +
            `  Either install in the checkout that owns it: \`cd ${tgt.replace(/[\\/]node_modules$/, "").replace(/\\/g, "/")} && npm ci\`\n` +
            `  or give this worktree its own install: remove ONLY the link first — \`cmd //c rmdir "${winPath(nm)}"\` (Windows) / \`rm "${nm}"\` ` +
            "(no -r, Unix) — then re-run the install here." +
            (hits.length > 1 ? `\n  Also linked: ${hits.slice(1).join(", ")}.` : "") +
            " (Disable via maple.config.json hooks.bashGuard.linkGuardEnabled=false.)",
        };
      }
    }
    for (const t of recursiveDelete(seg, base) ?? []) {
      const hit = throughLink(t);
      if (!hit) continue;
      return {
        deny:
          `BLOCKED (link-guard): \`${t.raw}\` ${hit.onLink ? "is" : "is inside"} ${hit.link}, a link to ${targetOf(hit.link)} (another ` +
          "checkout's install). A recursive delete there removes the TARGET's files, i.e. the main checkout's node_modules (D012).\n" +
          `  To drop the link alone: \`cmd //c rmdir "${winPath(hit.link)}"\` (Windows) / \`rm "${hit.link}"\` (no -r, Unix). ` +
          "To reinstall, see the install advice the guard prints for `npm ci` in that dir. " +
          "(Disable via maple.config.json hooks.bashGuard.linkGuardEnabled=false.)",
      };
    }
  }
  return undefined;
}
