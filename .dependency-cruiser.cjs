/**
 * dependency-cruiser config — enforces the layered architecture.
 *
 * Layers (intended dependency direction, top -> bottom):
 *   1. src/app/**            (Next.js App Router routes, layouts, route handlers)
 *   2. src/components/**     (feature components, excluding ui/)
 *   3. src/components/ui/    (presentational primitives — shadcn/ui-style)
 *   4. src/hooks/**          (React state/query wrappers, custom hooks)
 *   5. src/services/**       (Supabase + external API — the data layer)
 *   6. src/lib/**            (pure utilities)
 *
 * Run:    pnpm depcruise
 * Errors fail; warnings are advisory.
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "warn",
      comment:
        "Circular dependencies make code hard to reason about. Warn (not error) so an existing cycle doesn't block CI outright — tighten to 'error' once your codebase is cycle-free.",
      from: {},
      to: { circular: true, dependencyTypesNot: ["type-only"] },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment:
        "Orphaned modules (no importer) are a sign of dead code. Knip is authoritative; this rule is a backup.",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$",
          "\\.d\\.ts$",
          "(^|/)tsconfig\\.json$",
          "(^|/)package\\.json$",
          "src/components/ui/",
          "src/test/",
          "src/instrumentation",
          "src/sentry\\.",
          "src/app/",
          "scripts/",
          // Starter API surface (see knip.jsonc's ignore note) — remove
          // these exclusions once real code imports them.
          "src/lib/errorTracking\\.ts$",
          "src/services/supabase/",
          "src/types/database\\.types\\.ts$",
        ],
      },
      to: {},
    },
    {
      name: "services-no-react",
      severity: "error",
      comment:
        "Services are the data layer — they must not import React. Move React-aware logic to hooks/ or components/.",
      from: { path: "^src/services/" },
      to: { path: "^(react|react-dom)" },
    },
    {
      name: "lib-no-react",
      severity: "error",
      comment:
        "lib/ holds pure utilities. React imports belong in hooks/ or components/. Exception: lib/errorTracking + lib/sentryNoiseFilter operate on Sentry's SDK, not React.",
      from: {
        path: "^src/lib/",
        pathNot: ["^src/lib/errorTracking", "^src/lib/sentryNoiseFilter"],
      },
      to: { path: "^(react|react-dom)" },
    },
    {
      name: "lib-no-services",
      severity: "error",
      comment:
        "lib/ utilities should not depend on services/. Type-only imports are allowed (shared interfaces). If you need data at runtime, do it in a hook or component instead.",
      from: { path: "^src/lib/" },
      to: { path: "^src/services/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "ui-primitives-no-services",
      severity: "error",
      comment:
        "UI primitives must remain presentational. Business data belongs in feature components, not in src/components/ui/.",
      from: { path: "^src/components/ui/" },
      to: { path: "^src/services/" },
    },
    {
      name: "no-deprecated-core",
      severity: "warn",
      comment: "This module is deprecated in the Node core. Use a current alternative.",
      from: {},
      to: { dependencyTypes: ["deprecated"] },
    },
    {
      name: "not-to-spec",
      severity: "error",
      comment:
        "Production code should never depend on test files. If you need shared test utilities, move them out of __tests__/test dirs.",
      from: { pathNot: "(^|/)(__tests__|test)(/|\\b)" },
      to: { path: "(^|/)(__tests__|test)(/|\\b)|\\.test\\.(ts|tsx)$" },
    },
    {
      name: "no-non-package-json",
      severity: "error",
      comment:
        "Imported package not declared in package.json — runtime error waiting to happen. Add it as a direct dependency.",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "optional-deps-used",
      severity: "info",
      comment: "Optional deps are typically a smell when you depend on them.",
      from: {},
      to: { dependencyTypes: ["npm-optional"] },
    },
    {
      name: "peer-deps-used",
      severity: "warn",
      comment: "Peer deps usually mean a plugin pattern. Confirm this is intentional.",
      from: {},
      to: { dependencyTypes: ["npm-peer"] },
    },
  ],
  options: {
    doNotFollow: { path: ["node_modules"] },
    exclude: {
      path: [
        "node_modules",
        "\\.next",
        "out",
        "build",
        "public",
        "scripts",
        "e2e",
        "next\\.config\\.ts",
        "vitest\\.config\\.ts",
        "eslint\\.config\\.mjs",
      ],
    },
    includeOnly: ["^src/"],
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      mainFields: ["module", "main"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
      archi: {
        collapsePattern: "^(src/(app|components|hooks|services|lib))[^/]+",
      },
    },
  },
};
