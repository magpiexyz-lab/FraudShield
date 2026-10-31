import { test, expect } from "@playwright/test";

// The nav bar used to offer "Scan result" and "Dashboard" to everyone. Both
// routes are absent from publicPaths in src/proxy.ts, so a signed-out visitor
// clicking either was redirected to /login. Three public SEO guides now render
// this nav, and they exist to receive strangers from Google who have no
// account, so two of the nav's three links were rejections aimed at the
// highest-intent organic visitor the product has.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE DOES NOT SIMPLY "LOG OUT AND LOOK"
// ---------------------------------------------------------------------------
// There are no Supabase credentials in local development, so
// `createClient()` (src/lib/supabase.ts) takes its placeholder branch and
// returns createDemoClient() — whose `getSession()` resolves to a fake
// signed-in `demoUser`. Locally, after hydration, EVERY visitor is signed in.
// That is exactly why this bug reached production: no browser test run here can
// observe the anonymous state, so none of them ever contradicted it.
//
// So this file pins the two states that ARE deterministic here, which together
// bracket the conditional:
//
//   1. The SERVER-RENDERED HTML, fetched without executing JavaScript. `loading`
//      is true during server render, so the gated links must be absent. This is
//      literally the document Googlebot reads, and it is the state every
//      visitor — signed in or not — sees on first paint.
//
//   2. The HYDRATED DEMO SESSION, which is a signed-in user. The gated links
//      must COME BACK. Without this, a fix that simply deleted the links would
//      pass check 1 and silently break the nav for paying customers.
//
// The remaining case — hydrated AND genuinely anonymous — needs real Supabase
// credentials and is verified against production after deploy. The guard on
// that path is the unit assertion in tests/nav-bar.test.ts that the conditional
// reads both `loading` and `user`.

/**
 * The auth-gated routes, as a SET rather than two hard-coded link names.
 *
 * Stated this way on purpose: the next page appended to the nav carries no
 * forcing function to declare whether it is public, so a test naming only
 * "Dashboard" and "Scan result" would pass while a fourth gated link leaked
 * into the public fragment. Add any new auth-gated route here and the guard
 * extends with it.
 */
const AUTH_GATED_ROUTES = ["/dashboard", "/scan-result"] as const;

/** Public pages that render the NavBar. "/" and the auth pages suppress it. */
const PUBLIC_PAGES_WITH_NAV = ["/guides/fake-pay-stub", "/pricing"] as const;

/** The <nav aria-label="Primary"> block, isolated from page content. */
function navMarkup(html: string): string {
  const match = html.match(/<nav[^>]*aria-label="Primary"[\s\S]*?<\/nav>/);
  if (!match) throw new Error('nav[aria-label="Primary"] not found in server HTML');
  return match[0];
}

test.describe("server-rendered nav exposes no auth-gated route", () => {
  for (const path of PUBLIC_PAGES_WITH_NAV) {
    test(`${path} server HTML has no auth-gated nav link`, async ({
      request,
      baseURL,
    }) => {
      // request.get() fetches the document without running JavaScript, so this
      // asserts the pre-hydration markup — what a crawler indexes.
      const response = await request.get(new URL(path, baseURL).toString());
      expect(response.status()).toBe(200);

      const nav = navMarkup(await response.text());

      for (const route of AUTH_GATED_ROUTES) {
        expect(
          nav,
          `server-rendered nav must not link to the auth-gated route ${route}`,
        ).not.toContain(`href="${route}"`);
      }
    });

    test(`${path} server HTML still offers Pricing`, async ({
      request,
      baseURL,
    }) => {
      // Guards against "fixing" this by emptying the nav. /pricing is a
      // deliberate hand-added entry in proxy.ts publicPaths: it is the paywall
      // destination, and gating it bounced signed-out visitors to /login at the
      // exact moment they were deciding whether to pay.
      const response = await request.get(new URL(path, baseURL).toString());
      const nav = navMarkup(await response.text());
      expect(nav).toContain('href="/pricing"');
    });
  }
});

test.describe("hydrated signed-in nav still offers the gated routes", () => {
  // Local dev has no Supabase credentials, so the demo client resolves a fake
  // signed-in session. That makes this the signed-in case, and it is the half
  // of the conditional that a delete-the-links "fix" would break.
  for (const path of PUBLIC_PAGES_WITH_NAV) {
    test(`${path} desktop nav restores gated links once the session resolves`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);

      const nav = page.locator('nav[aria-label="Primary"]');
      await expect(nav).toBeVisible();

      for (const route of AUTH_GATED_ROUTES) {
        await expect(
          nav.locator(`a[href="${route}"]`),
          `signed-in nav must still link to ${route}`,
        ).toHaveCount(1);
      }
      await expect(nav.locator('a[href="/pricing"]')).toHaveCount(1);
    });

    test(`${path} mobile Sheet restores gated links once the session resolves`, async ({
      page,
    }) => {
      // navLinks is consumed twice — the desktop bar and this Sheet. A change
      // applied to one branch only passes a desktop-only test while phones,
      // where most search traffic reads these pages, diverge.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(path);

      await page.getByRole("button", { name: "Open menu" }).click();
      const sheet = page.getByRole("dialog");
      await expect(sheet).toBeVisible();

      for (const route of AUTH_GATED_ROUTES) {
        await expect(sheet.locator(`a[href="${route}"]`)).toHaveCount(1);
      }
      await expect(sheet.locator('a[href="/pricing"]')).toHaveCount(1);
    });
  }
});
