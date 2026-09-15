// Unit test for the b-11 behavior: a paying user can find, before and after
// paying, what the charge is, how to cancel, what happens when they do, and
// who to email.
//
// The copy under test lives in a plain module (src/lib/billing-copy.ts) rather
// than inside the /terms page, the /pricing FAQ and the landing footer,
// because vitest runs with environment: "node" and this project has no jsdom —
// a component cannot be rendered here. Asserting the module is the only way
// these obligations are testable at all, and it is also what stops the three
// surfaces drifting apart.
//
// The price is the load-bearing part: it must be DERIVED from PLAN_PRICES (the
// same server-authoritative constant /api/checkout charges on), so a price
// change cannot leave a stale number inside a binding promise.

import { describe, it, expect } from "vitest";
import { PLAN_PRICES } from "@/lib/types";
import {
  SUPPORT_EMAIL,
  SUPPORT_RESPONSE_SLA,
  PRO_PRICE_MONTHLY_USD,
  PRO_PRICE_LABEL,
  BILLING_TERMS,
  BILLING_FAQS,
} from "@/lib/billing-copy";

/** Every user-facing string the module exports, flattened. */
function allCopyStrings(): string[] {
  return [
    PRO_PRICE_LABEL,
    ...BILLING_TERMS.flatMap((t) => [t.heading, t.body]),
    ...BILLING_FAQS.flatMap((f) => [f.q, f.a]),
  ];
}

// Look a term up by id, failing loudly rather than returning undefined.
function term(id: string) {
  const found = BILLING_TERMS.find((t) => t.id === id);
  expect(found).toBeDefined();
  return found!;
}

describe("b-11: billing copy is derived from the charged price", () => {
  it("derives PRO_PRICE_MONTHLY_USD from PLAN_PRICES.pro", () => {
    expect(PRO_PRICE_MONTHLY_USD).toBe(Math.round(PLAN_PRICES.pro / 100));
  });

  it("labels the price with the derived figure and a monthly cadence", () => {
    expect(PRO_PRICE_LABEL).toContain(String(PRO_PRICE_MONTHLY_USD));
    expect(PRO_PRICE_LABEL).toContain("month");
  });

  // Regression guard: the point of the module is that the price is sourced.
  // Any dollar figure in the exported copy must be the derived one; a literal
  // left behind by a price change is a promise the product no longer honours.
  it("never states a dollar figure that disagrees with PLAN_PRICES", () => {
    const figures = allCopyStrings().flatMap(
      (s) => s.match(/\$\d[\d,]*/g) ?? [],
    );
    expect(figures.length).toBeGreaterThan(0);
    for (const figure of figures) {
      expect(figure.replace(/,/g, "")).toBe("$" + PRO_PRICE_MONTHLY_USD);
    }
  });
});

describe("b-11: the five binding billing terms", () => {
  const EXPECTED_IDS = [
    "subscription",
    "cancellation",
    "access-after-cancellation",
    "refunds",
    "support",
  ];

  const [SUBSCRIPTION, CANCELLATION, ACCESS, REFUNDS, SUPPORT] = EXPECTED_IDS;

  // The phrases each term is obliged to contain, lower-cased. A table rather
  // than an assertion per term: the obligations read as a checklist, and a term
  // that quietly loses its promise fails under its own id.
  const REQUIRED_PHRASES: Record<string, ReadonlyArray<string>> = {
    [SUBSCRIPTION]: ["monthly", "us dollars"],
    [CANCELLATION]: [
      "cancel at any time",
      "manage billing",
      "no cancellation fee",
    ],
    [ACCESS]: ["end of the month", "does not stop immediately"],
    [REFUNDS]: ["no refunds", "current month"],
    [SUPPORT]: ["invoice", "manage billing"],
  };

  it("lists exactly the five terms, in order", () => {
    expect(BILLING_TERMS.map((t) => t.id)).toEqual(EXPECTED_IDS);
  });

  it("gives every term a non-empty heading and body", () => {
    for (const t of BILLING_TERMS) {
      expect(t.heading.trim().length).toBeGreaterThan(0);
      expect(t.body.trim().length).toBeGreaterThan(0);
    }
  });

  it("states every obligation in the body of its own term", () => {
    for (const t of BILLING_TERMS) {
      const body = t.body.toLowerCase();
      for (const phrase of REQUIRED_PHRASES[t.id] ?? []) {
        expect(body).toContain(phrase);
      }
    }
  });

  it("quotes the derived price in the subscription term", () => {
    expect(term(SUBSCRIPTION).body).toContain(PRO_PRICE_LABEL);
  });

  it("names the support channel and the reply time in the support term", () => {
    const body = term(SUPPORT).body;
    expect(body).toContain(SUPPORT_EMAIL);
    expect(body).toContain(SUPPORT_RESPONSE_SLA);
  });
});

describe("b-11: the pricing FAQ answers the three billing questions", () => {
  const MANAGE_BILLING = "Manage billing";
  const NO_REFUNDS = "no refunds";
  const END_OF_MONTH = "end of the month";
  const answers = () => BILLING_FAQS.map((f) => f.a);

  it("has exactly three entries, each with a question and an answer", () => {
    expect(BILLING_FAQS).toHaveLength(3);
    for (const f of BILLING_FAQS) {
      expect(f.q.trim().length).toBeGreaterThan(0);
      expect(f.a.trim().length).toBeGreaterThan(0);
    }
  });

  // An FAQ that says "yes, you can cancel" without saying where the button is
  // is not an answer. These three assert the HOW, not the reassurance.
  it("tells the user where to cancel", () => {
    expect(answers().some((a) => a.includes(MANAGE_BILLING))).toBe(true);
  });

  it("gives an email fallback", () => {
    expect(answers().some((a) => a.includes(SUPPORT_EMAIL))).toBe(true);
  });

  it("repeats the refund position where the buying decision is made", () => {
    const joined = answers().toString().toLowerCase();
    expect(joined).toContain(NO_REFUNDS);
    expect(joined).toContain(END_OF_MONTH);
  });
});
