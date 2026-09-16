import { existsSync, readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  BILLING_TERMS,
  PRO_PRICE_LABEL,
  SUPPORT_EMAIL,
} from "@/lib/billing-copy";

// b-11 — /terms. The page is already linked from the landing footer and from
// the pricing page, so it has to exist; and because it states a commercial
// promise it has to render the shared copy module rather than a second,
// drifting copy of it.
//
// vitest runs environment "node" here and the project has no jsdom, so the
// page cannot be rendered. The page source is asserted as text instead, which
// is the right level for the thing actually at risk: not "does it paint", but
// "did someone retype the refund policy into JSX".

const repoRoot = path.resolve(__dirname, "..");
const pagePath = path.join(repoRoot, "src/app/terms/page.tsx");
const pageSource = existsSync(pagePath) ? readFileSync(pagePath, "utf8") : "";

describe("b-11: /terms page exists", () => {
  it("has a page component at src/app/terms/page.tsx", () => {
    expect(existsSync(pagePath)).toBe(true);
  });

  it("is a server component", () => {
    expect(pageSource).not.toMatch(/["']use client["']/);
  });

  it("exports Next metadata titled Terms", () => {
    expect(pageSource).toMatch(/export\s+const\s+metadata\s*:\s*Metadata/);
    expect(pageSource).toMatch(/title:\s*["'][^"']*Terms[^"']*["']/);
  });

  it("uses at least one component from the shared UI kit", () => {
    expect(pageSource).toMatch(/from\s+["']@\/components\/ui\//);
  });
});

describe("b-11: /terms renders the shared billing copy", () => {
  it("imports BILLING_TERMS from the copy module", () => {
    expect(pageSource).toMatch(
      /import\s*\{[\s\S]*?\bBILLING_TERMS\b[\s\S]*?\}\s*from\s*["']@\/lib\/billing-copy["']/
    );
  });

  it("maps over BILLING_TERMS instead of hardcoding the clauses", () => {
    expect(pageSource).toMatch(/BILLING_TERMS\.map\(/);
  });

  it("does not inline any clause body verbatim", () => {
    for (const term of BILLING_TERMS) {
      expect(pageSource).not.toContain(term.body);
    }
  });

  it("renders all five clauses the module defines", () => {
    expect(BILLING_TERMS).toHaveLength(5);
  });
});

describe("b-11: /terms hardcodes neither price nor support address", () => {
  it("has no hardcoded support address", () => {
    expect(SUPPORT_EMAIL).toBe("admin@draftlabs.org");
    expect(pageSource).not.toContain("admin@draftlabs.org");
  });

  it("has no hardcoded price", () => {
    expect(PRO_PRICE_LABEL).toContain("$60");
    expect(pageSource).not.toContain("$60");
  });

  it("links the support address as a mailto", () => {
    expect(pageSource).toMatch(/mailto:\$\{SUPPORT_EMAIL\}/);
  });
});
