// Guard: git-hook / signing bypass (D065). The gate is the enforcement; nothing an agent types may
// switch it off. Legitimate skips go through the gate's own reason + debt mechanism (D066).
//
// Denies: `--no-verify` on git commit|push|merge|rebase, `-n` on git commit, `-c core.hooksPath=...`,
// `git config [scope] core.hooksPath ...`, HUSKY=0 (env prefix, export, PowerShell $env:), --no-gpg-sign,
// `-c commit.gpgsign=false`. Reads the tokenizer's segments, so a commit MESSAGE mentioning a flag
// (quoted, heredoc, -m/-F value) is data, not a flag.
import { gitInfo, inspectableArgs } from "./shell.mjs";

const HOOKED = new Set(["commit", "push", "merge", "rebase"]);
const OFF = /^(false|no|off|0)$/i;
const WHY = " The gate is the enforcement: fix what it reports. A legitimate skip goes through the gate's own reason + debt mechanism (D066), never a flag.";

function deny(what) {
  return { deny: `BLOCKED (hook-bypass): ${what}.${WHY}` };
}

/** Short-flag cluster scan for `git commit`: true when `-n` appears before a value-taking letter. */
function commitDashN(text) {
  if (!/^-[A-Za-z]+$/.test(text)) return false;
  for (const ch of text.slice(1)) {
    if ("mFcCtS".includes(ch)) return false; // the rest of the cluster is that flag's value
    if (ch === "n") return true;
  }
  return false;
}

function off(value) {
  return OFF.test(String(value ?? "").replace(/^["']|["']$/g, ""));
}

export function check(ctx) {
  for (const seg of ctx.segments()) {
    if (seg.env.HUSKY !== undefined && off(seg.env.HUSKY)) return deny("HUSKY=0 disables the git hooks");
    if (seg.env.LEFTHOOK !== undefined && off(seg.env.LEFTHOOK)) return deny("LEFTHOOK=0 disables the git hooks");
    if (["export", "set", "declare", "setx", "env"].includes(seg.verb)) {
      for (const a of seg.args) {
        const m = /^(HUSKY|LEFTHOOK)=(.*)$/i.exec(a.text);
        if (m && off(m[2])) return deny(`${m[1].toUpperCase()}=0 disables the git hooks`);
      }
    }
    const ps = /^\$env:(husky|lefthook)(?:=(.*))?$/i.exec(seg.verb);
    if (ps) {
      const value = ps[2] ?? seg.args.map((a) => a.text).filter((t) => t !== "=").join("");
      if (off(value)) return deny(`$env:${ps[1].toUpperCase()}=0 disables the git hooks`);
    }

    const g = gitInfo(seg);
    if (!g) continue;
    for (const [key, value] of g.cfg) {
      if (key === "core.hookspath") return deny("`git -c core.hooksPath=...` redirects the git hooks");
      if (/^(commit|tag)\.gpgsign$/.test(key) && OFF.test(value)) return deny(`\`-c ${key}=false\` disables commit signing`);
    }
    const args = inspectableArgs(seg).filter((a) => g.args.includes(a));
    if (g.sub === "config") {
      const read = args.some((a) => /^--(get|get-all|get-regexp|list)$|^-l$/.test(a.text));
      const pos = args.filter((a) => !a.text.startsWith("-")).map((a) => a.text);
      const key = (pos[0] ?? "").toLowerCase();
      if (!read && key === "core.hookspath") return deny("`git config core.hooksPath` redirects or removes the git hooks");
      if (!read && /^(commit|tag)\.gpgsign$/.test(key) && OFF.test(pos[1] ?? "")) return deny("disabling commit.gpgsign");
      continue;
    }
    for (const a of args) {
      if (a.text === "--no-gpg-sign") return deny("`--no-gpg-sign` skips commit signing");
      if (HOOKED.has(g.sub) && a.text === "--no-verify") return deny(`\`git ${g.sub} --no-verify\` skips the git hooks`);
      if (g.sub === "commit" && commitDashN(a.text)) return deny("`git commit -n` is `--no-verify`: it skips the git hooks");
    }
  }
  return undefined;
}
