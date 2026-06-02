import { test, expect } from "@playwright/test";
import {
  getTestCredentials,
  login,
  captureAnalytics,
  type CapturedEvent,
} from "./helpers";

// Golden_path funnel: landing → cta_click → signup → upload → fraud score (activate).
// captureAnalytics intercepts /ingest/** so we can assert events fired in order
// without sending real data to PostHog.

test.describe.serial("FraudShield funnel", () => {
  let analytics: CapturedEvent[];

  test.beforeEach(async ({ page }) => {
    analytics = await captureAnalytics(page);
  });

  test("landing renders the headline and primary CTA", async ({ page }) => {
    await page.goto("/");
    // Landing has multiple CTAs (messaging.md Section B content inventory);
    // use .first() to bind to the hero CTA.
    await expect(
      page
        .getByRole("link", { name: /scan your first document free/i })
        .first(),
    ).toBeVisible();
  });

  test(
    "login redirects an authenticated user to the dashboard",
    async ({ page }) => {
      test.skip(
        process.env.DEMO_MODE === "true",
        "DB-dependent — re-run after /deploy",
      );
      const { email, password } = getTestCredentials();
      if (!email || !password) test.skip();
      await login(page, email, password);
      // The post-login destination is the dashboard (signup template default
      // routes there; login template routes to `/` but we then navigate).
      await page.goto("/dashboard");
      await expect(page).toHaveURL(/\/dashboard/);
    },
  );

  test(
    "dashboard renders the upload affordance",
    async ({ page }) => {
      test.skip(
        process.env.DEMO_MODE === "true",
        "DB-dependent — re-run after /deploy",
      );
      const { email, password } = getTestCredentials();
      if (!email || !password) test.skip();
      await login(page, email, password);
      await page.goto("/dashboard");
      await expect(
        page.getByRole("heading", { name: /scan a document/i }),
      ).toBeVisible();
      await expect(
        page.getByText(/drop a document to scan/i),
      ).toBeVisible();
    },
  );

  test("analytics: visit_landing fires on landing mount", async ({ page }) => {
    await page.goto("/");
    // Assert the deterministic sessionStorage marker the analytics lib writes
    // for testing (works regardless of POSTHOG_KEY presence — same pattern as
    // every assertion in behaviors.spec.ts).
    await page.waitForFunction(() =>
      window.sessionStorage.getItem("analytics:visit_landing") !== null
    , undefined, { timeout: 2000 });
    const marker = await page.evaluate(() =>
      window.sessionStorage.getItem("analytics:visit_landing"),
    );
    expect(marker).not.toBeNull();
  });
});
