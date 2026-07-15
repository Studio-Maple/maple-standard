// docs: docs/quality.md
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import securityPlugin from "eslint-plugin-security";

import requireDatabaseGeneric from "./eslint-rules/require-database-generic.mjs";

// Data layer — where Supabase clients are built and queries are issued. This
// glob gets the escape-proof type-safety layer: the custom
// require-database-generic rule + type-checked no-unsafe-* so `any` can't
// creep back in and silently un-type the schema surface.
const DATA_LAYER = ["src/services/supabase/*.ts"];

export default defineConfig([
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "coverage/**",
    // Claude Code hook scripts — tiny CJS infra, not app code. They must
    // stay dependency-free and require()-based so they run before any
    // install step; linting them with app rules is noise.
    ".claude/**",
    // Deno runtime — `deno check` (pre-commit) is the typechecker there;
    // Node-flavored ESLint rules (and the <Database> generic rule, which
    // targets the app's generated types) don't apply.
    "supabase/functions/**",
  ]),

  ...nextVitals,
  ...nextTs,

  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      security: securityPlugin,
      local: { rules: { "require-database-generic": requireDatabaseGeneric } },
    },
    settings: {
      "import/resolver": {
        typescript: true,
      },
    },
    rules: {
      // No `any` — the single biggest silent-failure vector in a TS codebase.
      "@typescript-eslint/no-explicit-any": "error",

      // Every Supabase client factory call must carry <Database>. Globally on
      // (only fires on create*Client calls), so an untyped client can never
      // be reintroduced anywhere.
      "local/require-database-generic": "error",

      // Block `// @ts-ignore` escapes that defeat typecheck. `@ts-expect-error`
      // with a description (>=3 chars) is allowed for genuine, time-boxed cases.
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          minimumDescriptionLength: 3,
        },
      ],

      // Surface `foo!.bar` non-null assertions that hide null bugs. Warn-level
      // so legitimate uses don't block CI; tests are exempted below.
      "@typescript-eslint/no-non-null-assertion": "warn",

      // Import order — React/external -> internal (@/*) -> relative -> types.
      "import/order": [
        "warn",
        {
          groups: [["builtin", "external"], "internal", ["parent", "sibling", "index"], "type"],
          pathGroups: [
            { pattern: "react", group: "builtin", position: "before" },
            { pattern: "react-dom/**", group: "builtin", position: "before" },
            { pattern: "@/**", group: "internal", position: "before" },
          ],
          pathGroupsExcludedImportTypes: ["react"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],

      // ── Security rules (eslint-plugin-security) ──
      // Curated subset focused on real risk in a Next.js + Node/Edge stack.
      // Some upstream defaults (detect-object-injection,
      // detect-non-literal-fs-filename) produce too many false positives in
      // ordinary React/route-handler code; left off.
      "security/detect-eval-with-expression": "error",
      "security/detect-pseudoRandomBytes": "error",
      "security/detect-buffer-noassert": "error",
      "security/detect-child-process": "error",
      "security/detect-disable-mustache-escape": "error",
      "security/detect-new-buffer": "error",
      "security/detect-no-csrf-before-method-override": "error",
      "security/detect-non-literal-regexp": "warn",
      "security/detect-unsafe-regex": "error",
      "security/detect-bidi-characters": "error",
    },
  },

  // shadcn/ui-style primitives — relaxed rules (generated/vendored code).
  {
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "import/order": "off",
      "max-lines": "off",
    },
  },

  // Tests — non-null assertions are idiomatic after
  // expect(...).toBeDefined(), and fixtures legitimately get long.
  {
    files: ["**/*.test.{ts,tsx}", "**/__tests__/**/*.{ts,tsx}", "e2e/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "max-lines": "off",
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // Data layer — escape-proof type safety.
  //
  // Type-checked linting (projectService) ONLY for the Supabase data layer,
  // so `any` cannot silently re-enter the query surface. If a client loses
  // its <Database> generic (or someone `as any`-casts a row), `.from()/.rpc()`
  // results become `any` and these rules fail the build at the point of use
  // — the backstop behind require-database-generic + the freshness gate.
  // ───────────────────────────────────────────────────────────────────────
  {
    files: DATA_LAYER,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // Size limits — per-layer base caps. Zero-tolerance: decompose a file when
  // it crosses the cap, don't raise the cap. Add a per-file ratchet entry
  // (a temporary, shrink-only override) ONLY for a file already over the cap
  // at adoption time, with a task tracked to bring it back down — see
  // CLAUDE.md "No bypass".
  // ───────────────────────────────────────────────────────────────────────
  {
    files: ["src/hooks/**/*.{ts,tsx}"],
    rules: { "max-lines": ["error", { max: 250 }] },
  },
  {
    files: ["src/components/**/*.{ts,tsx}"],
    rules: { "max-lines": ["error", { max: 300 }] },
  },
  {
    files: ["src/services/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: { "max-lines": ["error", { max: 350 }] },
  },
  {
    files: ["src/app/**/*.{ts,tsx}"],
    rules: { "max-lines": ["error", { max: 500 }] },
  },
  // Re-apply the ui/ override AFTER the component glob — flat config is
  // order-sensitive; later blocks win on overlapping rules.
  {
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: { "max-lines": "off" },
  },
]);
