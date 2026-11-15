// Fast lane (deploy first, enforce after): the pure rules - glob dialect, classification, config validation. Hermetic.
import assert from "node:assert/strict";
import { configHash, normalize, validatePredeploy } from "./config.mjs";
import { BASELINE_DENY, classify, globToRegExp, normalizeFastLane, rulesHash, validateFastLane } from "./fastlane-rules.mjs";

let n = 0;
const t = (name, fn) => { fn(); n++; console.log("ok - " + name); };
const m = (glob, path) => globToRegExp(glob).test(path);

// ── glob dialect ────────────────────────────────────────────────────────────
t("`**` crosses directories, `*` stays inside one segment, `?` is one character", () => {
  assert.ok(m("src/**", "src/a.ts") && m("src/**", "src/x/y/z.ts"));
  assert.ok(!m("src/**", "lib/src/a.ts") && !m("src/**", "srcx/a.ts"));
  assert.ok(m("src/*.ts", "src/a.ts") && !m("src/*.ts", "src/x/a.ts"));
  assert.ok(m("a/**/b.ts", "a/b.ts") && m("a/**/b.ts", "a/x/y/b.ts"));
  assert.ok(m("src/?.ts", "src/a.ts") && !m("src/?.ts", "src/ab.ts") && !m("src/?.ts", "src//.ts"));
});
t("`{a,b}` alternation, nested in a path", () => {
  assert.ok(m("src/**/*.{ts,tsx}", "src/a/b.tsx") && m("src/**/*.{ts,tsx}", "src/b.ts"));
  assert.ok(!m("src/**/*.{ts,tsx}", "src/b.js"));
});
t("a pattern without a slash matches the file name at any depth", () => {
  assert.ok(m("*.sql", "001.sql") && m("*.sql", "a/b/c/001.sql"));
  assert.ok(m("package.json", "package.json") && m("package.json", "apps/web/package.json"));
  assert.ok(!m("package.json", "apps/web/package.json.bak") && !m("package.json", "xpackage.json"));
});
t("matching is case-insensitive and tolerates backslashes and a ./ prefix in the pattern", () => {
  assert.ok(m("SRC/**", "src/A.ts") && m("*.SQL", "x/y.sql"));
  assert.ok(m("src\\**", "src/a.ts") && m("./src/**", "src/a.ts"));
});
t("regex metacharacters in a glob are literal", () => {
  assert.ok(m("a.b", "a.b") && !m("a.b", "axb"));
  assert.ok(m("src/(x)+.ts", "src/(x)+.ts"));
});
t("an unbalanced brace throws, either way round", () => {
  assert.throws(() => globToRegExp("src/{a,b"), /unbalanced "\{"/);
  assert.throws(() => globToRegExp("src/a,b}"), /unbalanced "\}"/);
});

// ── classify ────────────────────────────────────────────────────────────────
const pd = { allowlist: "predeploy-allowlist.json", decisions: "predeploy-decisions.json" };
const fl = { allow: ["src/**", "docs/**"], deny: [] };
const one = (path, f = fl, p = pd) => classify([{ path }], p, f);

t("an allowed path with no deny match is eligible", () => {
  const r = one("src/components/Button.tsx");
  assert.equal(r.eligible, true); assert.deepEqual(r.allowed, ["src/components/Button.tsx"]); assert.equal(r.denied.length, 0);
});
t("an empty diff is eligible (nothing to deny)", () => assert.equal(classify([], pd, fl).eligible, true));
t("every baseline class denies a representative path, with its class named", () => {
  const cases = [
    ["supabase/migrations/20260101_a.sql", /database migration/],
    ["db/schema.sql", /database migration/],
    ["infra/x.tf", /infrastructure/],
    ["deploy/vm/a.sh", /infrastructure/],
    ["docker-compose.yml", /infrastructure/],
    ["src/lib/auth/session.ts", /auth/],
    ["supabase/functions/foo/index.ts", /edge function/],
    ["package.json", /dependency/],
    ["apps/web/pnpm-lock.yaml", /dependency/],
    [".github/workflows/ci.yml", /CI \/ gate/],
    ["maple.config.json", /CI \/ gate/],
    ["predeploy-allowlist.json", /./],
    [".env.local", /secret \/ environment/],
    [".gitmodules", /git plumbing/],
  ];
  for (const [p, cls] of cases) {
    // also nested under src/ (so only the deny list can refuse them); root-anchored patterns (.github/**, the exact exception file) are root-only by design
    const rootOnly = /^(\.github\/|predeploy-allowlist\.json$)/.test(p);
    for (const path of rootOnly ? [p] : [p, "src/" + p]) {
      const r = classify([{ path }], pd, { allow: ["**/*.sql", "**/*", "src/**", "*.json", "*.yml", ".*"], deny: [] });
      assert.equal(r.eligible, false, path + " must be denied");
      assert.match(r.denied[0].reason, /^denied: /, path);
      if (path === p) assert.match(r.denied[0].reason, cls, path);
    }
  }
});
t("deny beats allow even when an allow pattern names the file", () => {
  const r = classify([{ path: "src/auth/login.ts" }], pd, { allow: ["src/auth/**"], deny: [] });
  assert.equal(r.eligible, false); assert.match(r.denied[0].reason, /^denied: auth/);
});
t("an unmatched path is unclassified, never silently eligible", () => {
  const r = one("scripts/unknown.txt");
  assert.equal(r.eligible, false); assert.match(r.denied[0].reason, /^unclassified: /);
});
t("`special` entries (submodule pointer, symlink) are denied even under an allowed path", () => {
  const r = classify([{ path: "src/vendored", special: "submodule pointer change" }, { path: "src/link", special: "symbolic link" }], pd, fl);
  assert.equal(r.eligible, false); assert.equal(r.denied.length, 2);
  assert.match(r.denied[0].reason, /submodule pointer change/); assert.match(r.denied[1].reason, /symbolic link/);
});
t("fastLane.deny adds a rule (and never removes a baseline one)", () => {
  assert.equal(one("src/pricing/rules.ts").eligible, true);
  const r = one("src/pricing/rules.ts", { allow: ["src/**"], deny: ["src/pricing/**"] });
  assert.equal(r.eligible, false); assert.match(r.denied[0].reason, /project deny list/);
  assert.equal(one("package.json", { allow: ["package.json", "**"], deny: [] }).eligible, false, "allow cannot lift a baseline deny");
});
t("the project's own exception files are denied by exact path, not by name at any depth", () => {
  const own = { allowlist: "config/gate-allow.json", decisions: "predeploy-decisions.json", imageDebt: { file: "docs/image-debt.json" } };
  const open = { allow: ["**/*"], deny: [] };
  for (const p of ["config/gate-allow.json", "predeploy-decisions.json", "docs/image-debt.json"]) assert.equal(classify([{ path: p }], own, open).eligible, false, p);
  assert.equal(classify([{ path: "docs/other/gate-allow.json" }], own, open).eligible, true, "same file name elsewhere is a different file");
  assert.match(classify([{ path: "config/gate-allow.json" }], own, open).denied[0].reason, /gate exception file/);
});
t("renames arrive as two entries and BOTH names are judged", () => {
  const r = classify([{ path: "src/a.ts" }, { path: "supabase/migrations/1.sql" }], pd, fl);
  assert.equal(r.eligible, false); assert.deepEqual(r.allowed, ["src/a.ts"]); assert.equal(r.denied.length, 1);
});
t("backslash paths classify like slash paths", () => {
  assert.equal(one("src\\a.ts").eligible, true);
  assert.equal(one("src\\auth\\a.ts").eligible, false);
});
t("every baseline glob compiles", () => { for (const c of BASELINE_DENY) for (const g of c.globs) assert.doesNotThrow(() => globToRegExp(g), g); });

// ── rules hash / normalize ──────────────────────────────────────────────────
t("rulesHash changes with allow, deny and the exception files, and is stable otherwise", () => {
  const a = rulesHash(pd, fl);
  assert.equal(a, rulesHash({ ...pd }, { allow: [...fl.allow], deny: [] }));
  assert.notEqual(a, rulesHash(pd, { ...fl, allow: ["src/**"] }));
  assert.notEqual(a, rulesHash(pd, { ...fl, deny: ["src/x/**"] }));
  assert.notEqual(a, rulesHash({ ...pd, allowlist: "other.json" }, fl));
});
t("normalizeFastLane: off unless enabled === true; defaults applied", () => {
  assert.equal(normalizeFastLane({}), null);
  assert.equal(normalizeFastLane({ fastLane: { enabled: false, allow: ["src/**"] } }), null);
  const f = normalizeFastLane({ fastLane: { enabled: true, allow: ["src/**"] } });
  assert.equal(f.deadlineHours, 12); assert.equal(f.permitMinutes, 60); assert.deepEqual(f.gateTiers, ["gate"]); assert.deepEqual(f.deny, []);
});

// ── validateFastLane ────────────────────────────────────────────────────────
const bad = (f) => validateFastLane({ fastLane: f });
const has = (errs, re) => errs.some((e) => re.test(e));
t("absent fastLane is valid; a valid block is valid", () => {
  assert.deepEqual(validateFastLane({}), []);
  assert.deepEqual(bad({ enabled: true, allow: ["src/**"], deny: ["src/pricing/**"], deadlineHours: 24, permitMinutes: 30, gateTiers: ["gate", "fast-2"] }), []);
  assert.deepEqual(bad({ enabled: false }), []);
});
t("not an object / unknown key / missing enabled", () => {
  assert.ok(has(validateFastLane({ fastLane: [] }), /must be an object/));
  assert.ok(has(bad({ enabled: true, allow: ["src/**"], bogus: 1 }), /fastLane\.bogus: unknown key/));
  assert.ok(has(bad({ allow: ["src/**"] }), /enabled: required boolean/));
  assert.ok(has(bad({ enabled: "yes", allow: ["src/**"] }), /enabled: required boolean/));
});
t("enabled without allow is refused (empty too)", () => {
  assert.ok(has(bad({ enabled: true }), /allow: required non-empty/));
  assert.ok(has(bad({ enabled: true, allow: [] }), /allow: required non-empty/));
});
t("allow: everything is refused in every spelling", () => {
  for (const g of ["**", "**/*", "*", "**/", "./**"]) assert.ok(has(bad({ enabled: true, allow: [g] }), /allows everything/), g);
  assert.ok(!has(bad({ enabled: true, allow: ["src/**"] }), /allows everything/));
});
t("deadlineHours bounds 1..48 (integers)", () => {
  for (const v of [0, 49, 1.5, "12", -1]) assert.ok(has(bad({ enabled: true, allow: ["src/**"], deadlineHours: v }), /deadlineHours/), String(v));
  for (const v of [1, 12, 48]) assert.deepEqual(bad({ enabled: true, allow: ["src/**"], deadlineHours: v }), [], String(v));
});
t("permitMinutes bounds 5..240", () => {
  for (const v of [0, 4, 241, 60.5]) assert.ok(has(bad({ enabled: true, allow: ["src/**"], permitMinutes: v }), /permitMinutes/), String(v));
  for (const v of [5, 60, 240]) assert.deepEqual(bad({ enabled: true, allow: ["src/**"], permitMinutes: v }), [], String(v));
});
t("gateTiers must be a non-empty list of tier names", () => {
  for (const v of [[], "gate", ["Gate X"], [""], [1]]) assert.ok(has(bad({ enabled: true, allow: ["src/**"], gateTiers: v }), /gateTiers/), JSON.stringify(v));
});
t("a bad glob in allow or deny is reported with its index", () => {
  assert.ok(has(bad({ enabled: true, allow: ["src/**", "src/{a,b"] }), /allow\[1\].*unbalanced/));
  assert.ok(has(bad({ enabled: true, allow: ["src/**"], deny: ["x/{"] }), /deny\[0\].*unbalanced/));
  assert.ok(has(bad({ enabled: true, allow: ["src/**"], deny: "x" }), /deny: array of glob strings/));
  assert.ok(has(bad({ enabled: true, allow: ["src/**", 3] }), /allow: array of glob strings/));
});

// ── wiring into the predeploy config ────────────────────────────────────────
const base = () => ({ project: { name: "t", slug: "t" }, predeploy: { checks: [{ id: "ok", command: "node -e 0" }] } });
const withFl = (f) => { const c = base(); c.predeploy.fastLane = f; return c; };
t("validatePredeploy accepts a valid fastLane block and reports an invalid one", () => {
  assert.deepEqual(validatePredeploy(base()), []);
  assert.deepEqual(validatePredeploy(withFl({ enabled: true, allow: ["src/**"] })), []);
  const errs = validatePredeploy(withFl({ enabled: true, allow: ["**"], deadlineHours: 0 }));
  assert.ok(has(errs, /allows everything/) && has(errs, /deadlineHours/));
});
t("opting in to the fast lane does NOT change the config hash (existing stamps stay valid)", () => {
  const plain = configHash(normalize(base()));
  assert.equal(configHash(normalize(withFl({ enabled: true, allow: ["src/**"] }))), plain);
  assert.equal(configHash(normalize(withFl({ enabled: true, allow: ["src/**", "docs/**"], deny: ["x/**"], deadlineHours: 3 }))), plain);
  assert.equal(configHash(normalize(withFl({ enabled: false }))), plain);
  // control: a field a stamp does certify still moves the hash
  const other = base(); other.predeploy.checks.push({ id: "b", command: "node -e 1" });
  assert.notEqual(configHash(normalize(other)), plain);
});

console.log(`\n${n} fast-lane unit tests passed`);
