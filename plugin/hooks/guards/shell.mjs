// Shared shell tokenizer for the hook guards (D065). One small parser so every guard reads a Bash or
// PowerShell command the same way: quoted strings, heredoc bodies and here-strings are consumed as
// data (a commit MESSAGE that mentions a flag is not a flag), `$(...)` / backtick substitutions are
// parsed into segments of their own (they execute), and each segment is normalised: env prefixes,
// `timeout N`, `sudo`/`nohup`/`env`, the call operator and the cwd set by an earlier `cd x &&` /
// `Set-Location x;` are stripped into fields instead of hiding the real verb.
//
// parseShell(command, shell) -> Segment[]
//   Segment = { verb, args: Word[], words: Word[], env, cd, anchored, nested }
//   Word    = { text, quoted, sub, redir }
// Pure functions, no I/O, no process spawn.

const WRAPPERS = new Set(["sudo", "nohup", "command", "time", "exec", "call", "builtin"]);
const CD_VERBS = new Set(["cd", "set-location", "sl", "chdir", "pushd"]);
const DATA_ONLY = new Set(["echo", "printf", "write-host", "write-output", "write-error", "write-verbose", "write-warning"]);
// Flags whose NEXT word is free text (a message / title / body), never a path or a command.
const MESSAGE_FLAGS = new Set(["-m", "--message", "--body", "-b", "--title", "--notes", "--description"]);

/** Normalise a path to lower-case forward-slash form: `/c/x`, `C:\x`, `C:/x`, `/cygdrive/c/x` -> `c:/x`. */
export function normPath(p) {
  let s = String(p ?? "").trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  s = s.replace(/^\/cygdrive\/([a-zA-Z])(?=\/|$)/, "$1:").replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:");
  s = s.replace(/\/{2,}/g, "/");
  const drive = /^[a-zA-Z]:/.test(s) ? s.slice(0, 2).toLowerCase() : "";
  const rest = drive ? s.slice(2) : s;
  const abs = rest.startsWith("/");
  const out = [];
  for (const part of rest.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    else if (part === ".." && abs) continue;
    else out.push(part);
  }
  const joined = out.join("/");
  if (drive) return `${drive}/${joined}`.replace(/\/$/, "") || `${drive}/`;
  return (abs ? "/" : "") + joined || (abs ? "/" : ".");
}

export function isAbsPath(p) {
  const s = String(p ?? "").trim().replace(/^["']|["']$/g, "");
  return /^[a-zA-Z]:[\\/]/.test(s) || /^[\\/]/.test(s) || s.startsWith("~");
}

class Parser {
  constructor(src, ps) {
    this.s = src;
    this.i = 0;
    this.ps = ps;
    this.out = [];
    this.cd = null;
    this.anchored = false;
  }

  /** Parse a command list; `inSub` stops at the unquoted `)` that closes a `$(`. */
  list(inSub, nested) {
    const s = this.s;
    let words = [];
    let w = null;
    let redirNext = false;
    const heredocs = [];
    const startWord = () => { if (!w) w = { text: "", quoted: false, sub: false, redir: redirNext }; return w; };
    const flushWord = () => { if (w) { words.push(w); w = null; redirNext = false; } };
    const flushSeg = () => {
      flushWord();
      if (words.length) this.push(words, nested);
      words = [];
      redirNext = false;
    };

    while (this.i < s.length) {
      const c = s[this.i];
      if (c === " " || c === "\t" || c === "\r") { flushWord(); this.i++; continue; }
      if (c === "\n") {
        flushSeg();
        this.i++;
        for (const h of heredocs.splice(0)) this.skipHeredocBody(h);
        continue;
      }
      if (c === "#" && !w) { while (this.i < s.length && s[this.i] !== "\n") this.i++; continue; }
      if (c === ";" || c === "|") { flushSeg(); this.i++; if (c === "|" && s[this.i] === "|") this.i++; else if (c === "|" && s[this.i] === "&") this.i++; continue; }
      if (c === "&") {
        if (s[this.i + 1] === "&") { flushSeg(); this.i += 2; continue; }
        if (this.ps && !w && words.length === 0) { this.i++; continue; } // PowerShell call operator
        flushSeg(); this.i++; continue;
      }
      if (c === "(") { flushSeg(); this.i++; continue; }
      if (c === ")") { this.i++; if (inSub) { flushSeg(); return; } flushSeg(); continue; }
      if (c === "<" && s[this.i + 1] === "<" && s[this.i + 2] !== "<" && !this.ps) {
        this.i += 2;
        let strip = false;
        if (s[this.i] === "-") { strip = true; this.i++; }
        while (s[this.i] === " " || s[this.i] === "\t") this.i++;
        let delim = "";
        const q = s[this.i];
        if (q === "'" || q === '"') {
          const end = s.indexOf(q, this.i + 1);
          delim = s.slice(this.i + 1, end < 0 ? s.length : end);
          this.i = end < 0 ? s.length : end + 1;
        } else {
          while (this.i < s.length && !/[\s;|&)<>]/.test(s[this.i])) { if (s[this.i] !== "\\") delim += s[this.i]; this.i++; }
        }
        if (delim) heredocs.push({ delim, strip });
        continue;
      }
      if (c === ">" || c === "<") {
        // a redirect: `2>`, `>>`, `>&1`, `<`, `<<<`; the NEXT word is its target
        if (w && /^\d+$/.test(w.text) && !w.quoted) w = null;
        flushWord();
        while (s[this.i] === ">" || s[this.i] === "<") this.i++;
        if (s[this.i] === "&") { this.i++; while (/[\d-]/.test(s[this.i] ?? "")) this.i++; redirNext = false; } else redirNext = true;
        continue;
      }
      if (this.ps && c === "@" && (s[this.i + 1] === "'" || s[this.i + 1] === '"') && /^[ \t]*\r?\n/.test(s.slice(this.i + 2))) {
        const q = s[this.i + 1];
        const close = new RegExp(`\\r?\\n${q}@`).exec(s.slice(this.i + 2));
        this.i = close ? this.i + 2 + close.index + close[0].length : s.length;
        startWord().quoted = true;
        continue;
      }
      if (c === "'") { this.single(startWord()); continue; }
      if (c === '"') { this.double(startWord()); continue; }
      if (c === "$" && s[this.i + 1] === "(") { this.i += 2; const cw = startWord(); cw.sub = true; cw.text += "$()"; this.list(true, true); continue; }
      if (c === "`") {
        if (this.ps) { // PowerShell escape char
          const nx = s[this.i + 1];
          this.i += 2;
          if (nx !== undefined && nx !== "\n" && nx !== "\r") startWord().text += nx;
          continue;
        }
        const end = s.indexOf("`", this.i + 1);
        const inner = s.slice(this.i + 1, end < 0 ? s.length : end);
        this.i = end < 0 ? s.length : end + 1;
        const cw = startWord(); cw.sub = true; cw.text += "$()";
        this.subParse(inner);
        continue;
      }
      if (c === "\\" && !this.ps) {
        const nx = s[this.i + 1];
        if (nx === "\n") { this.i += 2; continue; }
        if (nx !== undefined && /[\s"'$`\\]/.test(nx)) { startWord().text += nx; this.i += 2; continue; }
        startWord().text += c; this.i++; continue;
      }
      startWord().text += c;
      this.i++;
    }
    flushSeg();
  }

  subParse(inner) {
    const p = new Parser(inner, this.ps);
    p.cd = this.cd;
    p.anchored = this.anchored;
    p.list(false, true);
    this.out.push(...p.out);
  }

  single(word) {
    const s = this.s;
    word.quoted = true;
    this.i++;
    for (;;) {
      const end = s.indexOf("'", this.i);
      if (end < 0) { word.text += s.slice(this.i); this.i = s.length; return; }
      word.text += s.slice(this.i, end);
      this.i = end + 1;
      if (this.ps && s[this.i] === "'") { word.text += "'"; this.i++; continue; } // PS '' escape
      return;
    }
  }

  double(word) {
    const s = this.s;
    word.quoted = true;
    this.i++;
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '"') {
        if (this.ps && s[this.i + 1] === '"') { word.text += '"'; this.i += 2; continue; }
        this.i++;
        return;
      }
      if (c === "$" && s[this.i + 1] === "(") { this.i += 2; word.sub = true; word.text += "$()"; this.list(true, true); continue; }
      if (c === "`" && !this.ps) {
        const end = s.indexOf("`", this.i + 1);
        const inner = s.slice(this.i + 1, end < 0 ? s.length : end);
        this.i = end < 0 ? s.length : end + 1;
        word.sub = true; word.text += "$()";
        this.subParse(inner);
        continue;
      }
      if (c === "`" && this.ps) { word.text += s[this.i + 1] ?? ""; this.i += 2; continue; }
      if (c === "\\" && !this.ps && /["\\$`]/.test(s[this.i + 1] ?? "")) { word.text += s[this.i + 1]; this.i += 2; continue; }
      word.text += c;
      this.i++;
    }
  }

  skipHeredocBody({ delim, strip }) {
    const s = this.s;
    while (this.i < s.length) {
      let nl = s.indexOf("\n", this.i);
      if (nl < 0) nl = s.length;
      let line = s.slice(this.i, nl).replace(/\r$/, "");
      this.i = Math.min(nl + 1, s.length);
      if (strip) line = line.replace(/^\t+/, "");
      if (line === delim) return;
    }
  }

  push(words, nested) {
    const env = {};
    let k = 0;
    const text = (n) => words[n]?.text ?? "";
    // leading prefixes: VAR=val assignments and wrapper commands, in any order
    for (;;) {
      if (k >= words.length) break;
      const t = text(k);
      const lower = t.toLowerCase();
      if (!words[k].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { const eq = t.indexOf("="); env[t.slice(0, eq)] = t.slice(eq + 1); k++; continue; }
      const base = baseName(lower);
      if (WRAPPERS.has(base)) { k++; continue; }
      if (base === "timeout") { // timeout [-s sig] [-k dur] [--foreground] DURATION cmd
        k++;
        while (k < words.length && text(k).startsWith("-")) k += /^-[sk]$/.test(text(k)) ? 2 : 1;
        if (k < words.length && /^\d/.test(text(k))) k++;
        continue;
      }
      if (base === "nice") { k++; if (text(k) === "-n") k += 2; continue; }
      if (base === "env") { k++; while (k < words.length && (text(k).startsWith("-") || /^[A-Za-z_]\w*=/.test(text(k)))) { const m = /^([A-Za-z_]\w*)=(.*)$/.exec(text(k)); if (m) env[m[1]] = m[2]; k++; } continue; }
      break;
    }
    const rest = words.slice(k);
    if (!rest.length) return;
    const verb = baseName(rest[0].text.toLowerCase());
    const args = rest.slice(1).filter((x) => !x.redir);
    const seg = { verb, args, words: rest, env, cd: this.cd, anchored: this.anchored, nested: Boolean(nested) };
    if (CD_VERBS.has(verb)) {
      const operands = args.filter((a) => !/^-(path|literalpath|p|lp)$/i.test(a.text) && !a.text.startsWith("--"));
      const target = operands.find((a) => !a.text.startsWith("-"))?.text;
      if (target !== undefined) {
        const abs = isAbsPath(target);
        this.cd = abs || !this.cd ? normPath(target) : normPath(`${this.cd}/${target}`);
        if (abs) this.anchored = true;
      }
    }
    this.out.push(seg);
  }
}

function baseName(v) {
  return v.replace(/\\/g, "/").split("/").pop().replace(/\.(exe|cmd|bat|ps1)$/i, "");
}

/** @param {string} command @param {"bash"|"powershell"|string} [shell] @returns {Segment[]} */
export function parseShell(command, shell = "bash") {
  const p = new Parser(String(command ?? ""), /^p/i.test(shell));
  p.list(false, false);
  return p.out;
}

/** True for segments whose arguments are plain data (echo, printf, Write-Host, ...). */
export function isDataOnly(seg) {
  return DATA_ONLY.has(seg.verb);
}

/** The words a guard should inspect as flags/paths: message/title/body values are dropped. */
export function inspectableArgs(seg, { includeRedir = false } = {}) {
  const out = [];
  const args = includeRedir ? seg.words.slice(1) : seg.args;
  for (let n = 0; n < args.length; n++) {
    const t = args[n].text;
    if (MESSAGE_FLAGS.has(t)) { n++; continue; }
    if (/^--(message|body|title|notes|description)=/.test(t)) continue;
    out.push(args[n]);
  }
  return out;
}

/** `git [-C d] [-c k=v] <sub> ...` -> { sub, args, dir, cfg } or null when the segment is not git. */
export function gitInfo(seg) {
  if (seg.verb !== "git") return null;
  const a = seg.args;
  const cfg = [];
  let dir = null;
  let n = 0;
  for (; n < a.length; n++) {
    const t = a[n].text;
    if (t === "-C") { dir = a[++n]?.text ?? null; continue; }
    if (t === "-c") { const kv = a[++n]?.text ?? ""; const eq = kv.indexOf("="); cfg.push([(eq < 0 ? kv : kv.slice(0, eq)).toLowerCase(), eq < 0 ? "" : kv.slice(eq + 1)]); continue; }
    if (t.startsWith("--config-env=")) { cfg.push([t.slice(13).split("=")[0].toLowerCase(), "<env>"]); continue; }
    if (t.startsWith("-")) continue; // --no-pager, -p, --git-dir=..., --work-tree=...
    break;
  }
  if (n >= a.length) return { sub: "", args: [], dir, cfg };
  return { sub: a[n].text.toLowerCase(), args: a.slice(n + 1), dir, cfg };
}
