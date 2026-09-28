// b-11 — /pricing is the purchase surface, so the obligations that come with
// the charge have to be readable there, not only on /terms.
//
// vitest runs with environment "node" and this project has no jsdom, so the
// page cannot be rendered here. These assertions read page.tsx as source text
// and pair it with the imported module. The point of the pairing is that the
// billing prose must be SOURCED from @/lib/billing-copy rather than retyped:
// a second copy of a cancellation promise is a second cancellation policy.

import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { BILLING_FAQS, SUPPORT_EMAIL } from "@/lib/billing-copy";

const repoRoot = path.resolve(__dirname, "..");
const pricingSource = readFileSync(
  path.join(repoRoot, "src/app/pricing/page.tsx"),
  "utf8"
);

describe("b-11: pricing FAQ sources its billing answers from the shared module", () => {
  it("imports BILLING_FAQS and SUPPORT_EMAIL from @/lib/billing-copy", () => {
    const importMatch = pricingSource.match(
      /import\s*\{([^}]*)\}\s*from\s*["']@\/lib\/billing-copy["']/
    );
    expect(importMatch).not.toBeNull();
    expect(importMatch![1]).toContain("BILLING_FAQS");
    expect(importMatch![1]).toContain("SUPPORT_EMAIL");
  });

  it("splices the module's entries into the rendered FAQ list", () => {
    expect(pricingSource).toMatch(/\.\.\.BILLING_FAQS/);
  });

  it("carries every billing answer by reference, never as a retyped literal", () => {
    expect(BILLING_FAQS.length).toBe(3);
    for (const faq of BILLING_FAQS) {
      expect(faq.q.trim().length).toBeGreaterThan(0);
      expect(faq.a.trim().length).toBeGreaterThan(0);
      expect(pricingSource).not.toContain(faq.a);
    }
  });

  it("drops the old answer that allowed cancelling but never said how", () => {
    expect(pricingSource).not.toContain("Cancel whenever you like");
  });

  it("keeps the product answers that are not about billing", () => {
    expect(pricingSource).toContain(
      "What happens when I hit my free scan limit?"
    );
    expect(pricingSource).toContain("Do you store my uploaded documents?");
    expect(pricingSource).toContain(
      "What document types can FraudShield analyze?"
    );
  });
});

describe("b-11: pricing routes a buyer to support and to the terms", () => {
  it("links to the terms page", () => {
    expect(pricingSource).toContain('href="/terms"');
  });

  it("offers support as a mailto: link", () => {
    expect(pricingSource).toContain("mailto:");
  });

  it("does not hardcode the support address", () => {
    expect(SUPPORT_EMAIL).toBe("admin@draftlabs.org");
    expect(pricingSource).not.toContain("admin@draftlabs.org");
  });
});
