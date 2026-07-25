#!/usr/bin/env node
/**
 * frontmatter.mjs — small hand-rolled YAML-frontmatter reader for docs
 * pages (OKF v0.1 alignment, docs/decisions.md D010).
 *
 * Deliberately NOT a YAML parser — no new dependency is worth pulling in
 * for a flat metadata block. Supports exactly two line shapes between a
 * leading `---` / trailing `---` delimiter pair at the very top of the
 * file:
 *
 *   key: value
 *   key: [item, item, item]
 *
 * Limits (by design — reach for a real YAML lib if a doc ever needs more):
 *   - No multi-line scalars (block `|`/`>` styles), no nested maps/objects.
 *   - No YAML anchors/aliases/tags, no inline comments stripped mid-value.
 *   - One level of quoting: a value (or array item) wrapped in a single
 *     matching pair of "..." or '...' has that outer pair stripped — no
 *     escape-sequence handling inside the quotes.
 *   - Inline arrays split on top-level commas only: a brace group inside an
 *     item — e.g. `plugin/commands/{sweep-errors,burn-backlog}.md` — is
 *     NOT split apart, so glob-style path lists survive as one item.
 *   - A line that doesn't match `key: value` (or `key: [..]`) is silently
 *     ignored, not errored — keeps this parser forgiving of stray prose
 *     someone pastes into the block.
 *
 * Good enough for this project's flat OKF v0.1 schema (type/title/
 * description/tags/timestamp + this project's audience/authoritative_for/
 * code/reference_for custom fields) — nothing more.
 */

const DELIM = "---";

function stripQuotes(raw) {
  const s = raw.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

// Split on top-level commas only — depth-tracks () [] {} so a brace/bracket
// group inside one item isn't torn apart.
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    if (ch === "," && depth <= 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== "" || out.length) out.push(cur);
  return out.map((x) => stripQuotes(x));
}

function parseValue(raw) {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner).filter((x) => x !== "");
  }
  return stripQuotes(v);
}

/**
 * Parse a leading frontmatter block, if present.
 * @param {string} content full file text
 * @returns {{data: Record<string, string|string[]>, body: string} | null}
 *   null when the file has no `---`-delimited block at all, or the block is
 *   unterminated — both cases are treated as "legacy prose preamble page",
 *   never an error.
 */
export function parseFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== DELIM) return null;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === DELIM) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const data = {};
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (!m) continue;
    data[m[1]] = parseValue(m[2]);
  }
  const body = lines.slice(end + 1).join("\n");
  return { data, body };
}
