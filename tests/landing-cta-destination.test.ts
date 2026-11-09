import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// WHY THIS EXISTS.
//
// The free scan shipped 6 Nov 2026. In the days after it, no outside visitor
// started one. Every prominent call to action on the landing page went to
// /signup, and the only route to the scan was a small secondary link beside the
// hero CTA — so the page asked strangers for an account before letting them try
// the thing the account is for. Repointed 2026-11-09 at the manager's request;
// he counts the two-week free-scan test window from the day it goes live.
//
// This is a vitest source-text guard rather than a browser test because the
// Playwright suite is SKIPPED in CI on this repo (confirmed on PR #108), so an
// e2e assertion would not actually defend the change. e2e/behaviors.spec.ts
// asserts the same thing for anyone running it locally.

const read = (...p: string[]) =>
  readFileSync(join(__dirname, "..", ...p), "utf-8");

const LANDING = read("src", "components", "landing-content.tsx");
const PRICING = read("src", "app", "pricing", "pricing-plans.tsx");

/**
 * Code with prose removed.
 *
 * Load-bearing here: the comment on FREE_SCAN_ANCHOR explains the change by
 * naming BOTH strings this file forbids — "/signup" and the rooted
 * "/#live-demo". Left in, the explanation would trip the guard explaining it.
 * This repo has been caught by that exact trap seven times.
 */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const LANDING_CODE = codeOnly(LANDING);

describe("landing CTAs send visitors to the free scan", () => {
  it("is reading the real sources", () => {
    // Positive control: every negative assertion below passes vacuously
    // against an empty string.
    expect(LANDING.length).toBeGreaterThan(2_000);
    expect(LANDING_CODE.length).toBeGreaterThan(LANDING.length * 0.3);
    expect(LANDING_CODE).toContain("FREE_SCAN_ANCHOR");
    expect(PRICING.length).toBeGreaterThan(1_000);
  });

  it("routes no landing CTA to the signup wall", () => {
    // The defect itself. Three CTAs pointed here: the nav button, the hero
    // button and the closing button.
    expect(
      LANDING_CODE,
      'a landing CTA points at /signup again — that is the account wall the free scan exists to remove',
    ).not.toContain('href="/signup"');
  });

  it("anchors to the panel on the SAME page, not the rooted homepage", () => {
    // The variant-losing mistake, and the one worth a test of its own.
    //
    // /v/<slug> renders this same component, so each ad variant already has its
    // own free-scan panel. A rooted "/#live-demo" would send an ad visitor from
    // the variant they were recruited into over to the generic homepage,
    // dropping them out of the test mid-flight — and ad traffic is exactly who
    // this change serves. The bare hash scrolls down the page they are on.
    const declaration = LANDING_CODE.match(
      /FREE_SCAN_ANCHOR\s*=\s*"([^"]+)"/,
    );
    expect(declaration, "FREE_SCAN_ANCHOR is no longer a simple string").toBeTruthy();
    expect(declaration![1]).toBe("#live-demo");
  });

  it("points every CTA at one definition, so they cannot drift apart", () => {
    // Four links: nav, hero primary, hero secondary, closing.
    const uses = LANDING_CODE.match(/href=\{FREE_SCAN_ANCHOR\}/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
    // And nobody has re-hardcoded the anchor beside the constant.
    expect(LANDING_CODE).not.toContain('href="#live-demo"');
  });

  it("keeps firing cta_click on the repointed buttons", () => {
    // h-01 is cta_click / visit_landing and the manager reads it. Changing
    // where a button goes must not quietly stop it reporting that it was
    // clicked. The nav, hero and closing CTAs each carry the handler.
    const handlers = LANDING_CODE.match(/onClick=\{handleCtaClick\}/g) ?? [];
    expect(handlers.length).toBeGreaterThanOrEqual(3);
  });

  it("leaves the pricing plan CTA on signup", () => {
    // Explicitly carved out by the manager: that card sells the account plan,
    // so sign-up is the right next step there. A well-meaning sweep of
    // "every CTA should reach the free scan" would break it.
    expect(
      codeOnly(PRICING),
      "the pricing plan CTA no longer offers signup",
    ).toContain("/signup");
  });
});
