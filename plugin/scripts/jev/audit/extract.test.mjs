/**
 * Extraction, denylist, and glob-matching for tools/jev/audit-extract.mjs —
 * pure in-memory fixture strings, no repo checkout or git call needed.
 *
 *   node --test tools/jev/audit-extract.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bodyHash,
  extractFromSource,
  makeDenylistTest,
  matchesAnyGlob,
  matchesPathFilters,
  moduleOf,
  normalizeBody,
  parseSuppressions,
  truncateSource,
} from "./extract.mjs";

const EXTRACT_OPTS = { trivialMaxStatements: 3, trivialMaxLines: 4, maxSourceBytes: 6144 };

const FIXTURE = `
import { z } from "zod";

// a trivial one-liner — must be skipped
export function tiny(x) { return x + 1; }

export function bigEnough(items) {
  const out = [];
  for (const item of items) {
    if (item.active) out.push(item.id);
  }
  return out;
}

class Widget {
  render(props) {
    if (!props) return null;
    const label = props.label ?? "untitled";
    return { label, id: props.id };
  }
}

const handler = (req, res) => {
  const body = req.body;
  const parsed = JSON.parse(body);
  res.send(parsed);
};

const arr = [1, 2, 3].map(x => x * 2); // anonymous callback — must NOT be extracted
`;

test("extracts function declarations, methods, and named arrow/function expressions", () => {
  const fns = extractFromSource("fixture.ts", FIXTURE, EXTRACT_OPTS);
  const names = fns.map((f) => f.qualifiedName).sort();
  assert.deepEqual(names, ["Widget.render", "bigEnough", "handler"]);
});

test("skips trivial functions (under the statement/line threshold)", () => {
  const fns = extractFromSource("fixture.ts", FIXTURE, EXTRACT_OPTS);
  assert.ok(!fns.some((f) => f.qualifiedName === "tiny"), "tiny() should have been skipped as trivial");
});

test("does not extract anonymous callbacks", () => {
  const fns = extractFromSource("fixture.ts", FIXTURE, EXTRACT_OPTS);
  assert.ok(!fns.some((f) => f.qualifiedName.includes("anonymous")));
});

test("records line range, imports, and a body hash for each function", () => {
  const fns = extractFromSource("fixture.ts", FIXTURE, EXTRACT_OPTS);
  const big = fns.find((f) => f.qualifiedName === "bigEnough");
  assert.ok(big.startLine > 0 && big.endLine >= big.startLine);
  assert.match(big.imports, /import \{ z \} from "zod";/);
  assert.equal(typeof big.bodyHash, "string");
  assert.equal(big.bodyHash.length, 64); // sha256 hex
});

test("normalizeBody strips comments and whitespace so reformatting doesn't change the hash", () => {
  const a = "function f() {\n  // a comment\n  return 1;\n}";
  const b = "function f() { return 1; }";
  assert.equal(normalizeBody(a), normalizeBody(b));
  assert.equal(bodyHash(a), bodyHash(b));
});

test("truncateSource caps long source and marks truncation", () => {
  const long = "x".repeat(10_000);
  const { text, truncated } = truncateSource(long, 100);
  assert.ok(truncated);
  assert.ok(text.length < long.length);
  assert.match(text, /truncated/);
});

test("truncateSource leaves short source untouched", () => {
  const { text, truncated } = truncateSource("short", 100);
  assert.equal(text, "short");
  assert.equal(truncated, false);
});

test("makeDenylistTest matches by path pattern, name pattern, and the explicit file list", () => {
  const isDenylisted = makeDenylistTest({
    denylistPatterns: ["auth", "secret", "password"],
    denylistFiles: ["tools/jev/client.mjs"],
  });
  assert.ok(isDenylisted("core/auth/login.ts", "handleLogin"));
  assert.ok(isDenylisted("core/session.ts", "checkPassword"));
  assert.ok(isDenylisted("tools/jev/client.mjs", "evaluate"));
  assert.ok(!isDenylisted("core/session.ts", "computeSeverity"));
});

test("matchesAnyGlob supports **, *, and literal segments", () => {
  assert.ok(matchesAnyGlob("ui/src/foo.test.ts", ["**/*.test.*"]));
  assert.ok(matchesAnyGlob("design/mock.ts", ["design/**"]));
  assert.ok(!matchesAnyGlob("core/foo.ts", ["**/*.test.*"]));
});

test("matchesPathFilters treats a --path value as a directory prefix or glob", () => {
  assert.ok(matchesPathFilters("gateway/src/index.ts", ["gateway"]));
  assert.ok(!matchesPathFilters("core/src/index.ts", ["gateway"]));
  assert.ok(matchesPathFilters("core/foo/bar.ts", ["core/**"]));
});

test("moduleOf maps a path to its top-level scope directory", () => {
  const config = { scopeDirs: ["core", "ui/src", "gateway"] };
  assert.equal(moduleOf("ui/src/components/Foo.tsx", config), "ui");
  assert.equal(moduleOf("gateway/index.ts", config), "gateway");
  assert.equal(moduleOf("random/other.ts", config), "other");
});

test("moduleOf honours moduleLabels to split two scopeDirs that would otherwise collapse to the same top-level segment", () => {
  // EasyCaller's services/call-plane/src and services/srs/src would both map to "services"
  // without an override — moduleLabels is how audit.caller.json keeps them separate in the heatmap.
  const config = {
    scopeDirs: ["services/call-plane/src", "services/srs/src"],
    moduleLabels: { "services/call-plane/src": "call-plane", "services/srs/src": "srs" },
  };
  assert.equal(moduleOf("services/call-plane/src/app.ts", config), "call-plane");
  assert.equal(moduleOf("services/srs/src/index.ts", config), "srs");
});

test("makeDenylistTest also denylists an entire directory via denylistDirs", () => {
  const isDenylisted = makeDenylistTest({
    denylistPatterns: [],
    denylistFiles: [],
    denylistDirs: ["supabase/functions/admin-api"],
  });
  assert.ok(isDenylisted("supabase/functions/admin-api/index.ts", "handler"));
  assert.ok(isDenylisted("supabase/functions/admin-api/lib/util.ts", "helper"));
  assert.ok(!isDenylisted("supabase/functions/other-fn/index.ts", "handler"));
});

test("the excludeGlobs shape used by both audit configs keeps test helpers and build configs out of scope", () => {
  const excludeGlobs = [
    "**/*.test.*",
    "**/*.test-util.*",
    "**/*.spec.*",
    "**/test/**",
    "**/tests/**",
    "**/__tests__/**",
    "**/dist/**",
    "**/public/**/vendor/**",
    "**/*.config.*",
  ];
  // The MapleLens pilot ranked core/routes/harness.test-util.ts #3 and #5 — a test helper, not
  // product code — because *.test-util.* wasn't excluded yet.
  assert.ok(matchesAnyGlob("core/routes/harness.test-util.ts", excludeGlobs));
  assert.ok(matchesAnyGlob("app/src/lib/auth.spec.ts", excludeGlobs));
  assert.ok(matchesAnyGlob("services/call-plane/src/test/fixtures.ts", excludeGlobs));
  assert.ok(matchesAnyGlob("app/src/tests/helpers.ts", excludeGlobs));
  assert.ok(matchesAnyGlob("app/dist/bundle.js", excludeGlobs));
  assert.ok(matchesAnyGlob("app/public/vendor/lib.js", excludeGlobs));
  assert.ok(matchesAnyGlob("vite.config.ts", excludeGlobs));
  assert.ok(matchesAnyGlob("playwright.config.ts", excludeGlobs));
  assert.ok(!matchesAnyGlob("core/routes/harness.ts", excludeGlobs));
});

test("parseSuppressions reads a jev-audit accept comment", () => {
  const src = "// jev-audit: accept security — reviewed, input is already sanitized upstream\nfunction f() {}";
  assert.deepEqual(parseSuppressions(src), { security: "reviewed, input is already sanitized upstream" });
});

test("parseSuppressions accepts a plain ASCII hyphen separator too", () => {
  const src = "// jev-audit: accept efficiency - batches are bounded by config, not user input\nfunction f() {}";
  assert.deepEqual(parseSuppressions(src), { efficiency: "batches are bounded by config, not user input" });
});

test("parseSuppressions collects multiple accepted rules for the same function", () => {
  const src = [
    "// jev-audit: accept security — reviewed",
    "// jev-audit: accept efficiency — bounded by config",
    "function f() {}",
  ].join("\n");
  assert.deepEqual(parseSuppressions(src), { security: "reviewed", efficiency: "bounded by config" });
});

test("parseSuppressions finds nothing when there is no accept comment", () => {
  assert.deepEqual(parseSuppressions("function f() { return 1; }"), {});
});

test("extractFromSource attaches a function's leading-comment suppression to its record", () => {
  const src = [
    "// jev-audit: accept efficiency — bounded, reviewed 2026-09-23",
    "export function loopsALot(items) {",
    "  for (const a of items) for (const b of items) void (a === b);",
    "  return items.length;",
    "}",
  ].join("\n");
  const [fn] = extractFromSource("src/x.ts", src, EXTRACT_OPTS);
  assert.deepEqual(fn.suppressions, { efficiency: "bounded, reviewed 2026-09-23" });
});
