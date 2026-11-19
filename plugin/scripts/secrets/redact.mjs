/**
 * redact.mjs - exact-value stream redactor for maple-secret (D085).
 *
 * redactForms(value): the literal value plus its base64, base64url (padded and not), URL-encoded
 * (%20 and +) and JSON-escaped forms. StreamRedactor replaces every form with `[REDACTED:<Target>]`
 * in one regex pass (so a marker is never rescanned) and keeps a tail of (longest form - 1) chars
 * so a value split across two stream chunks is still caught.
 *
 * Honest limit: exact forms only. A child that transforms the value (reverse, hex, a base64 of a
 * larger text at another alignment) defeats it; this stops accidental echo, not a hostile child.
 */

export function redactForms(value) {
  const v = String(value);
  const b = Buffer.from(v, "utf8");
  const b64 = b.toString("base64");
  const url = encodeURIComponent(v);
  const forms = new Set([
    v,
    b64,
    b64.replace(/=+$/, ""),
    b64.replace(/\+/g, "-").replace(/\//g, "_"),
    b.toString("base64url"),
    url,
    url.replace(/%20/g, "+"),
    JSON.stringify(v).slice(1, -1),
  ]);
  forms.delete("");
  return [...forms];
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

export class StreamRedactor {
  /** @param {{target:string, value:string}[]} entries */
  constructor(entries) {
    this.map = new Map();
    for (const { target, value } of entries) {
      if (!value) continue;
      for (const f of redactForms(value)) if (!this.map.has(f)) this.map.set(f, `[REDACTED:${target}]`);
    }
    const keys = [...this.map.keys()].sort((a, b) => b.length - a.length);
    this.max = keys.length ? keys[0].length : 0;
    this.re = keys.length ? new RegExp(keys.map(escapeRe).join("|"), "g") : null;
    this.buf = "";
  }

  /** Feed text; returns the part that is safe to emit now. */
  push(text) {
    if (!this.re) return text;
    this.buf += text;
    return this.drain(Math.max(0, this.buf.length - (this.max - 1)));
  }

  /** Flush the held tail at end of stream. */
  end() {
    if (!this.re) return "";
    return this.drain(this.buf.length + 1);
  }

  /** Emit everything before index `cut` (matches STARTING before cut are fully decidable). */
  drain(cut) {
    const buf = this.buf;
    let out = "";
    let pos = 0;
    this.re.lastIndex = 0;
    for (let m = this.re.exec(buf); m && m.index < cut; m = this.re.exec(buf)) {
      out += buf.slice(pos, m.index) + this.map.get(m[0]);
      pos = m.index + m[0].length;
    }
    const upto = Math.min(Math.max(pos, cut), buf.length);
    if (upto > pos) out += buf.slice(pos, upto);
    this.buf = buf.slice(upto);
    return out;
  }
}
