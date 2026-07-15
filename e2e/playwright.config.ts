import { defineConfig, devices } from "@playwright/test";

// Local-only by default (deliberate — Playwright E2E runs
// in the local CI gate, not GitHub Actions, keeping cloud CI cheap). Wire a
// GitHub Actions job yourself once you have a stable preview/staging URL to
// target (Vercel preview deployments are a good fit — set BASE_URL to the
// preview URL and skip the managed webServer below).
const port = 3000;
const baseURL = process.env.BASE_URL ?? `http://localhost:${port}`;
const isExternalServer = !!process.env.BASE_URL;

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: [["html", { open: "never" }], ["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: isExternalServer
    ? undefined
    : {
        command: "pnpm build && pnpm start -- --port " + port,
        cwd: "..",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
