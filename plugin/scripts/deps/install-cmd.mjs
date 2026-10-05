/**
 * install-cmd.mjs — find version-pinned package specs in a package-manager install command (D064).
 *
 * `pnpm add react@17`, `npm i -D @scope/foo@^2`, `yarn add foo@~1`, `bun add foo@1.2.3` ->
 * `[{ name, spec }]`. Bare names, dist-tags (`@latest`, `@next`), paths, URLs and git specs are
 * not pinned versions and are ignored. A compound command (`a && b; c | d`) is scanned per segment.
 */

const SEGMENT_SPLIT = /&&|\|\||;|\||\r?\n/;
const SUBCOMMANDS = {
  pnpm: ["add", "install", "i"],
  npm: ["install", "i", "add"],
  yarn: ["add"],
  bun: ["add", "a"],
};
// flags that consume the next token as their value (when not written `--flag=value`)
const VALUE_FLAGS = new Set(["--filter", "-F", "--dir", "-C", "--prefix", "--registry", "--tag", "--cwd", "--workspace", "-w", "--save-prefix", "--loglevel", "--cache", "--userconfig"]);
// `-w` is pnpm's boolean "workspace root" flag, but npm's `-w <name>`; only npm consumes a value for it
const NPM_ONLY_VALUE_FLAGS = new Set(["-w"]);

function tokenize(segment) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of segment.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Split `name@spec` (scope-aware). Returns null for a bare name. */
export function splitSpecifier(token) {
  const alias = token.indexOf("@npm:"); // `foo@npm:bar@1` — the alias spec itself contains an `@`
  const at = alias > 0 ? alias : token.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: token.slice(0, at), spec: token.slice(at + 1) };
}

const VERSIONISH = /^(?:v?\d|[\^~<>=]|\*$|[xX]$|npm:)/;
const NOT_REGISTRY = /^(?:\.{0,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|file:|link:|git\+|git:|git@|https?:|ssh:|github:|[\w.-]+\/[\w.-]+$)|\.(?:tgz|tar|tar\.gz|zip)$/i;

function pinnedFrom(token) {
  if (NOT_REGISTRY.test(token)) return null;
  const parts = splitSpecifier(token);
  if (!parts || !parts.spec || !VERSIONISH.test(parts.spec)) return null; // bare name or dist-tag
  if (parts.spec === "*" || /^[xX]$/.test(parts.spec)) return null;
  return parts;
}

/** All version-pinned `{ name, spec }` the command would install. */
export function parseInstallSpecs(command) {
  const found = [];
  for (const segment of String(command).split(SEGMENT_SPLIT)) {
    const tokens = tokenize(segment);
    // skip leading `cd`, env assignments, `sudo`, `npx`-style wrappers: find the package manager token
    const pmIdx = tokens.findIndex((t) => Object.hasOwn(SUBCOMMANDS, t));
    if (pmIdx < 0) continue;
    const pm = tokens[pmIdx];
    let i = pmIdx + 1;
    while (i < tokens.length && tokens[i].startsWith("-")) i += valueSkip(tokens[i], pm) ? 2 : 1; // global flags before the subcommand
    if (!SUBCOMMANDS[pm].includes(tokens[i])) continue;
    for (i += 1; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t.startsWith("-")) {
        if (valueSkip(t, pm)) i += 1;
        continue;
      }
      const pinned = pinnedFrom(t);
      if (pinned) found.push(pinned);
    }
  }
  return found;
}

function valueSkip(flag, pm) {
  if (flag.includes("=")) return false;
  if (NPM_ONLY_VALUE_FLAGS.has(flag)) return pm === "npm";
  return VALUE_FLAGS.has(flag);
}
