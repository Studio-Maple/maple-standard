import { withSentryConfig } from "@sentry/nextjs";
import { realpathSync } from "node:fs";
import path from "node:path";

import type { NextConfig } from "next";

// Pin the workspace root to this repo so Next.js never mis-infers a parent
// directory's lockfile as the monorepo root. In a /wt-start worktree,
// node_modules is a junction into the main checkout (an ancestor of
// <repo>/.worktrees/<slug>); widen the root to that checkout so Turbopack
// accepts the junction instead of rejecting it as outside the root.
function turbopackRoot(): string {
  try {
    const modulesOwner = path.dirname(realpathSync(path.join(__dirname, "node_modules")));
    const rel = path.relative(modulesOwner, __dirname);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return modulesOwner;
  } catch {
    // no node_modules yet (fresh clone before install) — keep the repo root
  }
  return __dirname;
}

const nextConfig: NextConfig = {
  turbopack: {
    root: turbopackRoot(),
  },
};

export default withSentryConfig(nextConfig, {
  // Per-project instantiation: set these two (see README "Instantiate a new
  // project") and add SENTRY_AUTH_TOKEN as a build-time secret (Vercel env
  // var / GitHub secret) to enable source-map upload. Without an auth token
  // the plugin no-ops the upload step and the build still succeeds.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  widenClientFileUpload: true,
  // Skip the Sentry build step entirely when no org/project is configured
  // yet (fresh clone, before "instantiate a new project" is done) so
  // `next build` never fails on missing Sentry config.
  sourcemaps: {
    disable: !process.env.SENTRY_ORG || !process.env.SENTRY_PROJECT,
  },
});
