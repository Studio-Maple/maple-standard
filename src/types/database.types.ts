// AUTO-GENERATED — DO NOT EDIT BY HAND.
//
// Regenerate after every migration:
//   pnpm supabase:types
//
// The CI "types freshness" gate (scripts/ci-local.* + .github/workflows/
// supabase-migrations.yml) regenerates this from the live schema and fails
// the build on any diff — see docs/gaps.md if this file and the schema ever
// disagree. This placeholder ships an empty `public` schema so the template
// type-checks out of the box; the first real migration + `pnpm supabase:types`
// replaces it with the generated shape.

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}
