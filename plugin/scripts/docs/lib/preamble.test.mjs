#!/usr/bin/env node
/**
 * preamble.test.mjs — standalone test for preamble.mjs's readDocMeta (see
 * plugin/scripts/loops/budget.test.mjs for the repo's standalone test-style
 * convention: plain Node script, no framework, exits non-zero on failure).
 *
 * Covers the re-review fix (adopt-standard shakedown, defect 6): the legacy
 * blockquote preamble parser used to hardcode BOLD markdown labels
 * (`**Audience:**`) as the only recognized form. A real adopting project
 * (EasyCaller's docs/{engineering-standards,mvp-plan,security,
 * system-map}.md) uses the identical blockquote STRUCTURE without bold
 * (`> Audience: ...`), which used to produce false "no anchor" warnings —
 * overstating doc debt. Both forms must now parse identically, and a page
 * with Audience/Authoritative-for-only (no Code:/Enforced by:/etc. label)
 * must count as having an anchor, matching the frontmatter path's parity.
 *
 * node plugin/scripts/docs/lib/preamble.test.mjs
 */
import { readDocMeta } from "./preamble.mjs";

const results = [];
function pass(name, detail) {
  results.push({ name, passed: true });
  console.log(`  PASS  ${name} — ${detail}`);
}
function fail(name, detail) {
  results.push({ name, passed: false });
  console.log(`  FAIL  ${name} — ${detail}`);
}

// ── OKF v0.1 frontmatter ─────────────────────────────────────────────────

function testFrontmatterFullyPopulated() {
  const content = `---
type: spec
title: A Title
description: a description
tags: [a, b]
timestamp: 2026-07-25
audience: builders
authoritative_for: [thing one, thing two]
code: [src/a.ts, src/b.ts]
---
# A Title
Body text.
`;
  const m = readDocMeta(content);
  const ok =
    m.hasFrontmatter === true &&
    m.title === "A Title" &&
    m.audience === "builders" &&
    m.authoritative_for.length === 2 &&
    m.code.length === 2 &&
    m.hasAnyAnchor === true;
  if (ok) pass("frontmatter: fully populated parses", JSON.stringify(m));
  else fail("frontmatter: fully populated parses", JSON.stringify(m));
}

function testFrontmatterScalarFallsBackToCommaSplit() {
  // A plain scalar written where an array was expected — toArray() splits
  // it the same way the pre-D010 prose parser did.
  const content = `---
title: X
authoritative_for: thing one, thing two
---
# X
`;
  const m = readDocMeta(content);
  const ok = Array.isArray(m.authoritative_for) && m.authoritative_for.length === 2 && m.authoritative_for[1] === "thing two";
  if (ok) pass("frontmatter: scalar authoritative_for comma-splits", JSON.stringify(m.authoritative_for));
  else fail("frontmatter: scalar authoritative_for comma-splits", JSON.stringify(m));
}

function testFrontmatterNoAnchorAtAll() {
  const content = `---
title: X
type: guide
---
# X
`;
  const m = readDocMeta(content);
  if (m.hasAnyAnchor === false) pass("frontmatter: no audience/authoritative_for/code/reference_for -> no anchor", JSON.stringify(m));
  else fail("frontmatter: no audience/authoritative_for/code/reference_for -> no anchor", JSON.stringify(m));
}

// ── Legacy prose preamble — BOLD form (pre-existing, must keep working) ──

function testLegacyBoldFullyPopulated() {
  const content = `# A Title

> **Audience:** builders
> **Authoritative for:** thing one, thing two
> **Code:** \`src/a.ts\`, \`src/b.ts\`

Body text.
`;
  const m = readDocMeta(content);
  const ok =
    m.hasFrontmatter === false &&
    m.title === "A Title" &&
    m.audience === "builders" &&
    m.authoritative_for.length === 2 &&
    m.code.length === 2 &&
    m.hasAnyAnchor === true;
  if (ok) pass("legacy (bold): fully populated parses", JSON.stringify(m));
  else fail("legacy (bold): fully populated parses", JSON.stringify(m));
}

function testLegacyBoldEnforcedBy() {
  const content = `# A Title

> **Audience:** builders
> **Enforced by:** \`scripts/gate.mjs\`

Body.
`;
  const m = readDocMeta(content);
  const ok = m.code.length === 1 && m.code[0] === "scripts/gate.mjs" && m.hasAnyAnchor === true;
  if (ok) pass("legacy (bold): Enforced by: populates code[]", JSON.stringify(m));
  else fail("legacy (bold): Enforced by: populates code[]", JSON.stringify(m));
}

// ── Legacy prose preamble — NON-BOLD form (the real-world bug, defect 6) ─

function testLegacyPlainFullyPopulated() {
  // Structurally identical to EasyCaller's docs/engineering-standards.md.
  const content = `# Engineering Standards (inherited from VeHagita)

> Audience: anyone building Caller
> Authoritative for: stack, environments, CI, security, error tracking, conventions
> Source: VeHagita audit (proven patterns) + day-1 fixes for its known gaps

Caller mirrors VeHagita's engineering setup.
`;
  const m = readDocMeta(content);
  const ok =
    m.hasFrontmatter === false &&
    m.audience === "anyone building Caller" &&
    m.authoritative_for.length === 6 &&
    m.authoritative_for[0] === "stack" &&
    m.hasAnyAnchor === true;
  if (ok) pass("legacy (plain, no bold): Audience/Authoritative for recognized", JSON.stringify(m));
  else fail("legacy (plain, no bold): Audience/Authoritative for recognized", JSON.stringify(m));
}

function testLegacyPlainAudienceOnlyStillAnchors() {
  // No Code:/Enforced by:/Reference for:/Updated by:/Machine-readable: at
  // all — before the fix this was unconditionally "no anchor"; it must now
  // count as anchored via audience/authoritative_for, matching the
  // frontmatter path's own parity and check-docs-drift.mjs's warning text
  // ("audience/authoritative_for/code/reference_for").
  const content = `# MVP Build Plan

> Audience: builder
> Authoritative for: build sequence & scope
> Principle (founder): UI deprioritized

Mirrors the standards page.
`;
  const m = readDocMeta(content);
  const ok = m.code.length === 0 && m.reference_for === null && m.hasAnyAnchor === true;
  if (ok) pass("legacy (plain): audience/authoritative_for alone still counts as an anchor", JSON.stringify(m));
  else fail("legacy (plain): audience/authoritative_for alone still counts as an anchor", JSON.stringify(m));
}

function testLegacyPlainEnforcedBy() {
  const content = `# A Title

> Audience: builders
> Enforced by: \`scripts/gate.mjs\`

Body.
`;
  const m = readDocMeta(content);
  const ok = m.code.length === 1 && m.code[0] === "scripts/gate.mjs";
  if (ok) pass("legacy (plain, no bold): Enforced by: populates code[]", JSON.stringify(m));
  else fail("legacy (plain, no bold): Enforced by: populates code[]", JSON.stringify(m));
}

function testLegacyMixedBoldAndPlain() {
  // Real projects can be inconsistent line-to-line — each label must be
  // recognized independently of whether ITS neighbor happens to be bold.
  const content = `# A Title

> **Audience:** builders
> Authoritative for: thing one
> Reference for: the other doc

Body.
`;
  const m = readDocMeta(content);
  const ok = m.audience === "builders" && m.authoritative_for.length === 1 && m.reference_for === "the other doc";
  if (ok) pass("legacy: mixed bold + plain labels in the same block both recognized", JSON.stringify(m));
  else fail("legacy: mixed bold + plain labels in the same block both recognized", JSON.stringify(m));
}

function testLegacyTrulyBareHasNoAnchor() {
  // No Audience, no Authoritative for, no Code/Enforced-by/etc — must
  // still correctly report "no anchor" (the fix must not over-correct to
  // always true).
  const content = `# A Title

> Source: some prose note with no recognized label

Body.
`;
  const m = readDocMeta(content);
  if (m.hasAnyAnchor === false) pass("legacy: no recognized label at all -> no anchor (not over-corrected)", JSON.stringify(m));
  else fail("legacy: no recognized label at all -> no anchor (not over-corrected)", JSON.stringify(m));
}

function testNoPreambleAtAll() {
  const content = `# Just a title

Some plain body with no blockquote and no frontmatter.
`;
  const m = readDocMeta(content);
  const ok = m.hasFrontmatter === false && m.title === "Just a title" && m.hasAnyAnchor === false;
  if (ok) pass("no preamble at all -> title from H1, no anchor", JSON.stringify(m));
  else fail("no preamble at all -> title from H1, no anchor", JSON.stringify(m));
}

function main() {
  testFrontmatterFullyPopulated();
  testFrontmatterScalarFallsBackToCommaSplit();
  testFrontmatterNoAnchorAtAll();
  testLegacyBoldFullyPopulated();
  testLegacyBoldEnforcedBy();
  testLegacyPlainFullyPopulated();
  testLegacyPlainAudienceOnlyStillAnchors();
  testLegacyPlainEnforcedBy();
  testLegacyMixedBoldAndPlain();
  testLegacyTrulyBareHasNoAnchor();
  testNoPreambleAtAll();

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} assertions passed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
