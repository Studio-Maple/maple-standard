import { expect, test } from "@playwright/test";

// @smoke — the fast E2E subset run by the "gate" CI tier
// (scripts/ci-local.sh gate / .ps1 gate). Keep this tag small and reliable;
// broader coverage belongs in untagged specs run by the "core"/"full" tiers.
test.describe("smoke @smoke", () => {
  test("home page renders", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "maple-standard" })).toBeVisible();
  });

  test("health endpoint responds ok", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
