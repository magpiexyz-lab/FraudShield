import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// The two upgrade surfaces are React client components and this project has no
// DOM test runner, so these are source-level guards on the properties that
// cost real money if they regress:
//   - the fake door (/api/pay-intent, the early-access confirmation) is gone,
//   - both surfaces POST /api/checkout and fire checkout_start, and
//   - both release their fire-once latch when the flow does not navigate.
const SURFACES = {
  pricing: path.join(process.cwd(), "src", "app", "pricing", "pricing-plans.tsx"),
  scanResult: path.join(
    process.cwd(),
    "src",
    "app",
    "scan-result",
    "upgrade-cta.tsx",
  ),
};

function read(file: string): string {
  return readFileSync(file, "utf8");
}

describe.each(Object.entries(SURFACES))("%s upgrade surface", (_name, file) => {
  it("posts to the real checkout route", () => {
    expect(read(file)).toContain(String.raw`fetch("/api/checkout"`);
  });

  it("no longer calls the retired fake-door route", () => {
    expect(read(file)).not.toContain("/api/pay-intent");
    expect(read(file)).not.toContain("trackPayIntent");
  });

  it("fires checkout_start so both surfaces report the same funnel", () => {
    expect(read(file)).toContain("trackCheckoutStarted(");
  });

  it("releases the fire-once latch when the flow does not navigate", () => {
    expect(read(file)).toContain("firedRef.current = false");
  });

  it("navigates to the url the route returned", () => {
    expect(read(file)).toContain("window.location.href = outcome.url");
  });

  it("handles the not_configured product state", () => {
    expect(read(file)).toContain("not_configured");
  });

  it("shows no post-click confirmation that nothing was charged", () => {
    const source = read(file);
    expect(source).not.toMatch(/early-access list/i);
    expect(source).not.toMatch(/have not been charged/i);
  });
});

describe("scan-result upgrade CTA", () => {
  it("keeps the auth + activation render guard", () => {
    expect(read(SURFACES.scanResult)).toContain(
      "if (!user || !hasActivated) return null",
    );
  });
});
