import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { PLAN_PRICES } from "@/lib/types";

const repoRoot = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

const proxySource = read("src/proxy.ts");
const layoutSource = read("src/app/layout.tsx");

describe("b-11: /terms is publicly reachable", () => {
  it("lists /terms in the proxy publicPaths array", () => {
    const match = proxySource.match(/const publicPaths\s*=\s*\[([\s\S]*?)\]/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain("\"/terms\"");
  });
});

describe("b-11: structured-data price is derived, not hardcoded", () => {
  it("does not hardcode the stale $49 price in JSON-LD", () => {
    expect(layoutSource).not.toContain("price: \"49\"");
    expect(layoutSource).not.toContain("price: '49'");
  });

  it("imports PLAN_PRICES from @/lib/types", () => {
    expect(layoutSource).toMatch(
      /import\s*\{[^}]*\bPLAN_PRICES\b[^}]*\}\s*from\s*["']@\/lib\/types["']/
    );
  });

  it("derives the advertised price from PLAN_PRICES.pro", () => {
    expect(Math.round(PLAN_PRICES.pro / 100)).toBe(60);
  });
});

// b-12 ships three guide pages that must be readable by a stranger arriving from
// Google with no account. The single /terms assertion above cannot catch the way
// this breaks: src/proxy.ts is hand-maintained (nothing regenerates it after
// bootstrap), so a new public page is added by editing one literal array, and
// both a forgotten entry and an accidental deletion are silent in production —
// the page simply redirects to /login.
//
// The expected list below is the output of
//   python3 .claude/scripts/lib/derive_pages.py public_paths < experiment/experiment.yaml
// (10 derived paths) plus "/pricing", which is an intentional non-derived extra:
// it is the paywall destination and no behavior marks it anonymous_allowed, so
// derive_public_paths() will never emit it, yet gating it behind auth bounced
// signed-out visitors to /login at the moment they were deciding whether to pay.
//
// Hardcoded on purpose. Shelling out to the derive script would make this test
// depend on pyyaml, which CI installs in a different job from the one that runs
// vitest, and js-yaml is an undeclared eslint transitive. Re-run the command
// above by hand when experiment.yaml behaviors change.
const EXPECTED_PUBLIC_PATHS = [
  "/",
  "/api/health",
  "/auth/callback",
  "/auth/reset-password",
  "/guides/edited-pdf",
  "/guides/fake-bank-statement",
  "/guides/fake-pay-stub",
  "/login",
  "/pricing",
  "/signup",
  "/terms",
];

function parsePublicPaths(): string[] {
  const match = proxySource.match(/const publicPaths\s*=\s*\[([\s\S]*?)\]/);
  expect(match).not.toBeNull();
  return [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("b-12: the three guide pages are publicly reachable", () => {
  it("matches the derived public path set exactly, with /pricing as the only extra", () => {
    // Sorted so a reordering of the literal array is not a failure, while a
    // missing guide path, a typo, or a dropped /pricing all still fail.
    expect([...parsePublicPaths()].sort()).toEqual([...EXPECTED_PUBLIC_PATHS].sort());
  });

  it("matches on exact equality, so each guide path needs its own entry", () => {
    // A single "/guides" prefix entry would not work: the proxy tests
    // `pathname === p`, never startsWith.
    expect(proxySource).toContain("pathname === p");
    for (const slug of ["fake-pay-stub", "fake-bank-statement", "edited-pdf"]) {
      expect(parsePublicPaths()).toContain(`/guides/${slug}`);
    }
  });
});

describe("b-12: guides are discoverable by search engines", () => {
  const sitemapSource = read("src/app/sitemap.ts");

  it("lists all three guide URLs in the sitemap", () => {
    for (const slug of ["fake-pay-stub", "fake-bank-statement", "edited-pdf"]) {
      expect(sitemapSource).toContain(`/guides/${slug}\``);
    }
  });

  it("carries the Search Console verification token in the root metadata", () => {
    // Renders as <meta name="google-site-verification"> via Next's
    // metadata.verification.google. Without it Search Console will not accept
    // the property, and the sitemap above can never be submitted.
    expect(layoutSource).toContain("6jyisz8z5MiSIqP8NU8QwtQz2X-rVikhfFldreNaOrA");
    expect(layoutSource).toMatch(/verification:\s*\{\s*google:/);
  });
});
