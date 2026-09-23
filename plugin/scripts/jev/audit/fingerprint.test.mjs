/**
 * Deterministic duplicate-candidate detection — tools/jev/audit-fingerprint.mjs.
 *
 *   node --test tools/jev/audit-fingerprint.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dedupeNearDuplicatePairs,
  dupCacheKey,
  findCandidatePairs,
  findExactDuplicateClusters,
  fingerprintOf,
  jaccard,
  selectPairsForJev,
} from "./fingerprint.mjs";

const FN_A = `function sumActive(items) {
  let total = 0;
  for (const item of items) {
    if (item.active) total += item.value;
  }
  return total;
}`;

// Same structure, renamed identifiers and a different literal — should still be a near-duplicate.
const FN_B = `function addEnabled(records) {
  let sum = 0;
  for (const record of records) {
    if (record.enabled) sum += record.amount;
  }
  return sum;
}`;

const FN_C = `function fetchUser(id) {
  return db.query("SELECT * FROM users WHERE id = ?", [id]);
}`;

test("jaccard of identical shingle sets is 1, disjoint sets is 0", () => {
  const a = fingerprintOf(FN_A, 5);
  assert.equal(jaccard(a, a), 1);
  const c = new Set(["zzz"]);
  assert.equal(jaccard(a, c), 0);
});

test("findCandidatePairs flags structurally-identical, renamed functions above the threshold", () => {
  const functions = [
    { id: "a.ts#sumActive", source: FN_A },
    { id: "b.ts#addEnabled", source: FN_B },
    { id: "c.ts#fetchUser", source: FN_C },
  ];
  const pairs = findCandidatePairs(functions, { shingleSize: 5, threshold: 0.5 });
  assert.ok(pairs.some((p) => (p.aId === "a.ts#sumActive" && p.bId === "b.ts#addEnabled") || (p.aId === "b.ts#addEnabled" && p.bId === "a.ts#sumActive")));
  // The unrelated function should not pair with either of the near-duplicates.
  assert.ok(!pairs.some((p) => p.aId === "c.ts#fetchUser" || p.bId === "c.ts#fetchUser"));
});

test("findCandidatePairs finds nothing below the threshold", () => {
  const functions = [
    { id: "a.ts#sumActive", source: FN_A },
    { id: "c.ts#fetchUser", source: FN_C },
  ];
  const pairs = findCandidatePairs(functions, { shingleSize: 5, threshold: 0.6 });
  assert.equal(pairs.length, 0);
});

test("selectPairsForJev drops pairs where either side is denylisted, and applies the cap", () => {
  const pairs = [
    { aId: "a", bId: "b", jaccard: 0.9 },
    { aId: "a", bId: "sensitive", jaccard: 0.8 },
    { aId: "c", bId: "d", jaccard: 0.7 },
  ];
  const isDenylistedId = (id) => id === "sensitive";
  const { pairs: selected, droppedForDenylist, droppedForCap } = selectPairsForJev(pairs, {
    inScopeIds: new Set(["a", "c"]),
    isDenylistedId,
    cap: 10,
  });
  assert.equal(selected.length, 2);
  assert.ok(!selected.some((p) => p.aId === "sensitive" || p.bId === "sensitive"));
  assert.equal(droppedForDenylist, 1);
  assert.equal(droppedForCap, 0);
});

test("selectPairsForJev requires at least one side in scope", () => {
  const pairs = [{ aId: "out1", bId: "out2", jaccard: 0.9 }];
  const { pairs: selected } = selectPairsForJev(pairs, { inScopeIds: new Set(["only-this"]), isDenylistedId: () => false, cap: 10 });
  assert.equal(selected.length, 0);
});

test("selectPairsForJev enforces the cap and reports how many were dropped", () => {
  const pairs = Array.from({ length: 5 }, (_, i) => ({ aId: `a${i}`, bId: `b${i}`, jaccard: 0.9 }));
  const inScopeIds = new Set(pairs.flatMap((p) => [p.aId, p.bId]));
  const { pairs: selected, droppedForCap } = selectPairsForJev(pairs, { inScopeIds, isDenylistedId: () => false, cap: 2 });
  assert.equal(selected.length, 2);
  assert.equal(droppedForCap, 3);
});

test("selectPairsForJev's cap keeps the highest-Jaccard pairs when input is sorted worst-first", () => {
  // findCandidatePairs always returns its pairs sorted descending by Jaccard; selectPairsForJev
  // must preserve that order when slicing to the cap, not drop arbitrarily.
  const pairs = [
    { aId: "a", bId: "b", jaccard: 0.95 },
    { aId: "c", bId: "d", jaccard: 0.8 },
    { aId: "e", bId: "f", jaccard: 0.61 }, // weakest — should be the one dropped at cap 2
  ];
  const inScopeIds = new Set(pairs.flatMap((p) => [p.aId, p.bId]));
  const { pairs: selected } = selectPairsForJev(pairs, { inScopeIds, isDenylistedId: () => false, cap: 2 });
  assert.deepEqual(selected.map((p) => p.jaccard), [0.95, 0.8]);
});

// ── exact-duplicate clustering (the MapleLens pilot's `jsonResponse` copy-pasted into ~16 route files) ──

test("findExactDuplicateClusters groups 2+ functions sharing a bodyHash, and ignores unique-body functions", () => {
  const functions = [
    { id: "a.ts#jsonResponse", bodyHash: "H1" },
    { id: "b.ts#jsonResponse", bodyHash: "H1" },
    { id: "c.ts#jsonResponse", bodyHash: "H1" },
    { id: "d.ts#uniqueFn", bodyHash: "H2" },
  ];
  const clusters = findExactDuplicateClusters(functions);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].bodyHash, "H1");
  assert.deepEqual(clusters[0].memberIds.sort(), ["a.ts#jsonResponse", "b.ts#jsonResponse", "c.ts#jsonResponse"]);
  assert.equal(clusters[0].probability, 1);
  assert.equal(clusters[0].source, "deterministic");
});

test("findExactDuplicateClusters only reports a cluster touching at least one in-scope function, when inScopeIds is given", () => {
  const functions = [
    { id: "out1", bodyHash: "H1" },
    { id: "out2", bodyHash: "H1" },
    { id: "in1", bodyHash: "H2" },
    { id: "in2", bodyHash: "H2" },
  ];
  const clusters = findExactDuplicateClusters(functions, { inScopeIds: new Set(["in1"]) });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].bodyHash, "H2");
});

test("dedupeNearDuplicatePairs drops pairs that are exact duplicates (same bodyHash) outright", () => {
  const byId = new Map([
    ["a", { id: "a", bodyHash: "H1" }],
    ["b", { id: "b", bodyHash: "H1" }],
  ]);
  const pairs = [{ aId: "a", bId: "b", jaccard: 1 }];
  assert.deepEqual(dedupeNearDuplicatePairs(pairs, byId), []);
});

test("dedupeNearDuplicatePairs keeps at most one representative pair per pair of exact-duplicate clusters", () => {
  // Two clusters of 3 near-identical functions each — 9 possible cross pairs, but they're all
  // structurally the same comparison (every member of cluster A is byte-identical to every other
  // member), so only one should survive, and it should be the highest-Jaccard one (input order preserved).
  const byId = new Map([
    ["a1", { id: "a1", bodyHash: "CLUSTER_A" }],
    ["a2", { id: "a2", bodyHash: "CLUSTER_A" }],
    ["a3", { id: "a3", bodyHash: "CLUSTER_A" }],
    ["b1", { id: "b1", bodyHash: "CLUSTER_B" }],
    ["b2", { id: "b2", bodyHash: "CLUSTER_B" }],
  ]);
  const pairs = [
    { aId: "a1", bId: "b1", jaccard: 0.9 },
    { aId: "a1", bId: "b2", jaccard: 0.85 },
    { aId: "a2", bId: "b1", jaccard: 0.8 },
    { aId: "a2", bId: "b2", jaccard: 0.75 },
    { aId: "a3", bId: "b1", jaccard: 0.7 },
  ];
  const deduped = dedupeNearDuplicatePairs(pairs, byId);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].jaccard, 0.9); // first (highest-Jaccard) survives
});

test("dedupeNearDuplicatePairs is a no-op for functions with unique bodies", () => {
  const byId = new Map([
    ["a", { id: "a", bodyHash: "UNIQUE_A" }],
    ["b", { id: "b", bodyHash: "UNIQUE_B" }],
  ]);
  const pairs = [{ aId: "a", bId: "b", jaccard: 0.7 }];
  assert.deepEqual(dedupeNearDuplicatePairs(pairs, byId), pairs);
});

test("dupCacheKey is order-independent", () => {
  assert.equal(dupCacheKey("h1", "h2"), dupCacheKey("h2", "h1"));
});
