import { test, expect } from "@playwright/test";
import { blockAnalytics, checkNoHorizontalOverflow } from "./helpers";

// Page-load smoke tests — one per page derived from experiment.yaml via
// derive_scope_pages(). Each test verifies the page renders with SOME title
// and does not produce horizontal overflow. Full funnel/journey tests live
// in funnel.spec.ts; behavior-level assertions live in behaviors.spec.ts.

test.describe.serial("Page-load smoke tests", () => {
  test.beforeEach(async ({ page }) => {
    await blockAnalytics(page);
  });

  test("landing page loads", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/.+/);
    await checkNoHorizontalOverflow(page);
  });

  test("signup page loads", async ({ page }) => {
    await page.goto("/signup");
    await expect(page).toHaveTitle(/.+/);
    await checkNoHorizontalOverflow(page);
  });

  test("login page loads", async ({ page }) => {
    await page.goto("/login");
    await expect(page).toHaveTitle(/.+/);
    await checkNoHorizontalOverflow(page);
  });

  test("dashboard page loads", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveTitle(/.+/);
    await checkNoHorizontalOverflow(page);
  });

  test("scan-result page loads", async ({ page }) => {
    await page.goto("/scan-result");
    await expect(page).toHaveTitle(/.+/);
    await checkNoHorizontalOverflow(page);
  });

  test("pricing page loads", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page).toHaveTitle(/.+/);
    await checkNoHorizontalOverflow(page);
  });

  test("terms page loads", async ({ page }) => {
    const response = await page.goto("/terms");
    // b-11 regression guard: /terms must stay in the src/proxy.ts publicPaths
    // list. Without it the middleware redirects anonymous visitors to /login,
    // which turns the signed-out footer link into a dead end.
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/terms$/);
    await expect(page).toHaveTitle(/.+/);
    // Support contact is the escalation path the billing terms point readers to.
    await expect(page.locator('a[href^="mailto:"]').first()).toBeVisible();
    await checkNoHorizontalOverflow(page);
  });

  // --- variant landings ---

  test("variant stop-the-loss loads", async ({ page }) => {
    await page.goto("/v/stop-the-loss");
    await expect(page).toHaveTitle(/.+/);
    await checkNoHorizontalOverflow(page);
  });

  test("variant seconds-not-hours loads", async ({ page }) => {
    await page.goto("/v/seconds-not-hours");
    await expect(page).toHaveTitle(/.+/);
    await checkNoHorizontalOverflow(page);
  });

  test("variant built-for-small-operators loads", async ({ page }) => {
    await page.goto("/v/built-for-small-operators");
    await expect(page).toHaveTitle(/.+/);
    await checkNoHorizontalOverflow(page);
  });
});
