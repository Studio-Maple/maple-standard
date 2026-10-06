import react from "@vitejs/plugin-react";
import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

// Two projects (D066): React-free code (src/lib, src/services) runs in the `node` environment - no jsdom
// boot per file - and everything else in `jsdom`. Both inherit the root plugins/aliases/env/setup.
const NODE_DIRS = ["src/lib", "src/services"];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY:
        "test-anon-key-not-a-real-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: NODE_DIRS.map((d) => `${d}/**/*.{test,spec}.{ts,tsx}`),
        },
      },
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["src/**/*.{test,spec}.{ts,tsx}"],
          exclude: [...configDefaults.exclude, ...NODE_DIRS.map((d) => `${d}/**`)],
        },
      },
    ],
  },
});
