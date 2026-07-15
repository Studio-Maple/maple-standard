import { withSentryConfig } from "@sentry/nextjs";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root to this repo so Next.js never mis-infers a
  // parent directory's lockfile as the monorepo root.
  turbopack: {
    root: __dirname,
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
