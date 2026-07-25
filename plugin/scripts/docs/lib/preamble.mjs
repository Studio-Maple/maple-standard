#!/usr/bin/env node
/**
 * preamble.mjs — unified doc-preamble reader. OKF v0.1 frontmatter
 * (docs/decisions.md D010) is the target shape; a legacy prose blockquote
 * preamble is still fully supported as a fallback (VeHagita's ~65 pages
 * migrate later, #T5) — callers get a normalized shape either way, plus
 * `hasFrontmatter` so the drift gate can warn on legacy pages to keep
 * migration pressure on.
 *
 * Frontmatter fields recognized:
 *   OKF-reserved:  type, title, description, tags, timestamp
 *   Custom:        audience, authoritative_for, code, reference_for
 *     - `code` is the owned-paths list the drift gate existence-checks —
 *       it replaces the prose `**Code:**` / `**Enforced by:**` anchor.
 *     - `reference_for` replaces the prose `**Reference for:**` anchor —
 *       descriptive text, never existence-checked (unchanged from before).
 *
 * Legacy prose preamble (`# Title` + `> **Label:** ...` blockquote):
 * existence-checkable paths still come ONLY from a `Code:`/`Enforced by:`
 * label, exactly as before D010 — `Reference for:`/`Updated by:`/
 * `Machine-readable:` stay informational-only anchors.
 */
import { parseFrontmatter } from "./frontmatter.mjs";

function toArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  // A plain scalar written where an array was expected (or the legacy
  // preamble's comma-joined prose) — split the same way the pre-D010
  // parser split `Authoritative for:`.
  return String(v)
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstH1(content) {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "";
}

function parseLegacyPreamble(content) {
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !lines[i].startsWith("# ")) i++;
  const title = i < lines.length ? lines[i].replace(/^#\s+/, "").trim() : "";
  i++;
  while (i < lines.length && lines[i].trim() === "") i++;
  const block = [];
  while (i < lines.length && lines[i].startsWith(">")) {
    block.push(lines[i].replace(/^>\s?/, ""));
    i++;
  }
  const joined = block.join("\n");

  const audienceMatch = joined.match(/\*\*Audience:\*\*\s*(.+?)(?=\n|$)/);
  const audience = audienceMatch ? audienceMatch[1].trim().replace(/\.$/, "") : null;

  const authMatch = joined.match(/\*\*Authoritative for:\*\*\s*(.+?)(?=\n|$)/);
  const authoritative_for = authMatch
    ? authMatch[1]
        .replace(/\.$/, "")
        .split(/,\s*/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  let anchorType = null;
  let anchorRaw = null;
  for (const label of ["Code", "Enforced by", "Reference for", "Updated by", "Machine-readable"]) {
    const re = new RegExp(`\\*\\*${label.replace(/\s/g, "\\s")}:\\*\\*\\s*(.+?)(?=\\n|$)`);
    const m = joined.match(re);
    if (m) {
      anchorType = label.toLowerCase().replace(/\s/g, "_");
      anchorRaw = m[1];
      break;
    }
  }

  const code =
    anchorType === "code" || anchorType === "enforced_by"
      ? [...(anchorRaw || "").matchAll(/`([^`]+)`/g)].map((mm) => mm[1])
      : [];
  const reference_for = anchorType === "reference_for" ? anchorRaw.trim() : null;

  return {
    title,
    audience,
    authoritative_for,
    code,
    reference_for,
    hasAnyAnchor: anchorType !== null,
  };
}

/**
 * @param {string} content full file text
 * @returns normalized preamble: { hasFrontmatter, title, type, description,
 *   tags[], timestamp, audience, authoritative_for[], code[], reference_for,
 *   hasAnyAnchor, body }
 */
export function readDocMeta(content) {
  const fm = parseFrontmatter(content);
  if (fm) {
    const { data, body } = fm;
    const authoritative_for = toArray(data.authoritative_for);
    const code = toArray(data.code);
    const reference_for = data.reference_for ? String(data.reference_for) : null;
    return {
      hasFrontmatter: true,
      title: data.title || firstH1(body) || "(no H1)",
      type: data.type || null,
      description: data.description || null,
      tags: toArray(data.tags),
      timestamp: data.timestamp || null,
      audience: data.audience || null,
      authoritative_for,
      code,
      reference_for,
      hasAnyAnchor: Boolean(data.audience || authoritative_for.length || code.length || reference_for),
      body,
    };
  }
  const legacy = parseLegacyPreamble(content);
  return {
    hasFrontmatter: false,
    title: legacy.title,
    type: null,
    description: null,
    tags: [],
    timestamp: null,
    audience: legacy.audience,
    authoritative_for: legacy.authoritative_for,
    code: legacy.code,
    reference_for: legacy.reference_for,
    hasAnyAnchor: legacy.hasAnyAnchor,
    body: content,
  };
}
