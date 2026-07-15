/**
 * Custom ESLint rule — require an explicit `<Database>` generic on every
 * Supabase client factory call.
 *
 * `createClient` / `createBrowserClient` / `createServerClient` from
 * `@supabase/supabase-js` and `@supabase/ssr` default their `Database` type
 * parameter to `any`. Without an explicit `<Database>`, the entire query
 * surface (`.from(...).select(...)`, `.rpc(...)`) is typed `any`, so a
 * hallucinated table/column is a runtime failure or silent wrong data instead
 * of a compile error. This rule makes the typed-client wiring non-regressable:
 * the build fails the moment a client is created untyped or with the wrong
 * generic. Pairs with the freshness gate (regenerate `database.types.ts` +
 * fail on diff) and `no-unsafe-*` on the data layer (see eslint.config.mjs's
 * DATA_LAYER block).
 *
 * The rule is generic to any Supabase + TypeScript project.
 */

const CLIENT_FACTORY = /^create(Browser|Server)?Client$/;

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require an explicit <Database> generic on Supabase client factory calls",
    },
    schema: [],
    messages: {
      missingGeneric:
        "{{name}}(...) must be parameterized: {{name}}<Database>(...). An untyped client types every query as `any`, defeating schema checking.",
      wrongGeneric:
        "{{name}}(...) must use <Database> (the generated schema type) as its first type argument so queries are checked against the live schema.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "Identifier" || !CLIENT_FACTORY.test(callee.name)) {
          return;
        }
        // typescript-eslint exposes call type arguments as `typeArguments`
        // (current ESTree) or `typeParameters` (legacy). Support both.
        const typeArgs = node.typeArguments ?? node.typeParameters;
        const first = typeArgs && typeArgs.params && typeArgs.params[0];
        if (!first) {
          context.report({ node, messageId: "missingGeneric", data: { name: callee.name } });
          return;
        }
        const isDatabase =
          first.type === "TSTypeReference" &&
          first.typeName &&
          first.typeName.type === "Identifier" &&
          first.typeName.name === "Database";
        if (!isDatabase) {
          context.report({ node: first, messageId: "wrongGeneric", data: { name: callee.name } });
        }
      },
    };
  },
};

export default rule;
