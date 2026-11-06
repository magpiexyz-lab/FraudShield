import { describe, expect, it } from "vitest";
import sitemap from "@/app/sitemap";
import { VARIANTS } from "@/lib/variants";

// Why this exists.
//
// src/app/sitemap.ts was generated at bootstrap by emit-sitemap.py, which
// enumerates dynamic routes from experiment.yaml behaviors[*].dynamic_segments.
// The A/B variants are not declared there — they live under the top-level
// `variants:` key — so the generator emitted one placeholder fixture slug,
// `demo-fixture-variant`, and none of the real ones.
//
// That shipped. The live sitemap submitted to Google Search Console pointed
// crawlers at https://fraudshield.draftlabs.org/v/demo-fixture-variant, which
// returns 404, and never mentioned stop-the-loss, seconds-not-hours or
// built-for-small-operators — the three pages experiment/ads.yaml spends the
// ad budget on. Verified against production before the fix.
//
// These assertions are behavioural: they call the real default export and the
// real VARIANTS array. They are not source-text checks, so moving the
// implementation around is fine as long as the output stays correct.

const entries = sitemap();
const urls = entries.map((e) => e.url);

describe("sitemap variant coverage", () => {
  it("lists every variant that actually has a page", () => {
    // VARIANTS is the same array src/app/v/[variant]/page.tsx hands to
    // generateStaticParams, so this is the exact set of /v/ pages that exist.
    for (const v of VARIANTS) {
      expect(
        urls.some((u) => u.endsWith(`/v/${v.slug}`)),
        `/v/${v.slug} has a prerendered page but is missing from the sitemap`,
      ).toBe(true);
    }
  });

  it("lists no /v/ page that does not exist", () => {
    const known = new Set(VARIANTS.map((v) => v.slug));
    const listed = urls
      .filter((u) => u.includes("/v/"))
      .map((u) => u.slice(u.lastIndexOf("/v/") + 3));

    for (const slug of listed) {
      expect(
        known.has(slug),
        `sitemap advertises /v/${slug}, which has no entry in VARIANTS and will 404`,
      ).toBe(true);
    }
  });

  it("never reintroduces the bootstrap placeholder", () => {
    // Named explicitly because this is the exact value that shipped, and a
    // regeneration from the unchanged generator would bring it straight back.
    expect(urls.some((u) => u.includes("demo-fixture-variant"))).toBe(false);
  });

  it("lists exactly as many /v/ entries as there are variants", () => {
    // Catches a duplicate, which the two membership tests above would both pass.
    const count = urls.filter((u) => u.includes("/v/")).length;
    expect(count).toBe(VARIANTS.length);
  });

  // Positive control. Every assertion above is satisfiable by an empty or
  // malformed sitemap — if sitemap() returned [] the loops would not execute
  // and the negative checks would pass vacuously.
  it("returns a populated sitemap with the core static pages", () => {
    expect(VARIANTS.length).toBeGreaterThan(0);
    expect(entries.length).toBeGreaterThan(VARIANTS.length);
    for (const path of ["/", "/pricing", "/signup", "/terms"]) {
      expect(
        urls.some((u) => u.endsWith(path)),
        `${path} missing — sitemap() is not returning the real list`,
      ).toBe(true);
    }
  });

  it("gives every entry an absolute URL when the site URL is configured", () => {
    // base() falls back to "" when NEXT_PUBLIC_SITE_URL is unset, which yields
    // relative paths. The sitemap protocol requires absolute URLs, and the
    // prebuild guard asserts the variable in production — so this only holds
    // where it is set, and is skipped rather than failed locally.
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
    if (!siteUrl) return;
    for (const u of urls) {
      expect(u.startsWith("http"), `${u} is not an absolute URL`).toBe(true);
    }
  });
});
