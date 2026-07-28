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

// Matches a legacy preamble label at the start of a blockquote line
// (`joined` has already had the leading `> ` stripped off each line), in
// EITHER of the two forms real projects use: bold-wrapped (`**Audience:**
// value`, this template's own convention) or bare (`Audience: value`, no
// `**` at all — e.g. EasyCaller's docs/{engineering-standards,mvp-plan,
// security,system-map}.md, all four of which use the identical blockquote
// STRUCTURE without bold). Anchored to the start of a line (the `m` flag)
// so a label word appearing mid-sentence elsewhere in the block can't
// false-match. Returns the raw value string, or null if the label isn't
// present in either form.
function legacyLabelValue(joined, label) {
  const esc = label.replace(/\s/g, "\\s");
  const re = new RegExp(`^[ \\t]*\\*{0,2}${esc}:\\*{0,2}[ \\t]*(.+?)[ \\t]*$`, "m");
  const m = joined.match(re);
  return m ? m[1] : null;
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

  const audienceRaw = legacyLabelValue(joined, "Audience");
  const audience = audienceRaw ? audienceRaw.trim().replace(/\.$/, "") : null;

  const authRaw = legacyLabelValue(joined, "Authoritative for");
  const authoritative_for = authRaw
    ? authRaw
        .replace(/\.$/, "")
        .split(/,\s*/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

  let anchorType = null;
  let anchorRaw = null;
  for (const label of ["Code", "Enforced by", "Reference for", "Updated by", "Machine-readable"]) {
    const v = legacyLabelValue(joined, label);
    if (v !== null) {
      anchorType = label.toLowerCase().replace(/\s/g, "_");
      anchorRaw = v;
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
    // Parity with the frontmatter path's hasAnyAnchor (readDocMeta below):
    // audience/authoritative_for count as an anchor there, so they must
    // count here too — check-docs-drift.mjs's own "no anchor" warning text
    // (`audience/authoritative_for/code/reference_for`) already documents
    // this as one unified anchor set, not a frontmatter-only one. Before
    // this fix, a legacy page with Audience/Authoritative for but no
    // Code:/Enforced by:/etc. label was always flagged "no anchor" even
    // though it plainly has point-to-code-adjacent metadata — the same
    // false-debt overstatement the bold/non-bold fix above addresses.
    hasAnyAnchor: anchorType !== null || audience !== null || authoritative_for.length > 0,
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
