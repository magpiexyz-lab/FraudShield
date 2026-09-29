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

import { readFileSync } from "fs";
import path from "path";
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

/** Repo root, for reading component source that this copy must agree with. */
const repoRoot = path.resolve(__dirname, "..");

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
      SUPPORT_EMAIL,
      "no cancellation fee",
    ],
    [ACCESS]: ["end of the month", "does not stop immediately"],
    [REFUNDS]: ["no refunds", "current month"],
    [SUPPORT]: ["invoice", SUPPORT_EMAIL],
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

// The restacking guard.
//
// This block used to assert the OPPOSITE: that the copy named no in-app
// control at all. That was right while the self-serve billing portal sat
// unmerged — naming a button that did not exist would have been a binding
// term that was false on the day it shipped.
//
// The portal now ships (src/app/dashboard/manage-billing.tsx, backed by
// /api/billing-portal), so that premise is dead and this guard is inverted.
// The requirement is literally "cancel any time from the account page", and a
// customer told to email us when a button would have done it in two clicks has
// been handed the slow route to something we sold as easy.
//
// The obligation is now two-sided, and both sides are load-bearing:
//   1. the cancel and invoice copy NAMES the real control, and
//   2. it still names SUPPORT_EMAIL as the fallback, for anyone locked out of
//      their dashboard — email stays a documented route, not a deleted one.
// Reverting either half fails here.
describe("b-11: the billing copy names the in-app control that now ships", () => {
  const CANCELLATION_ID = "cancellation";
  const SUPPORT_ID = "support";

  // Asserted against the component's own source rather than retyped from
  // memory. That is the point of this constant: a label invented here, or
  // renamed there, sends the customer hunting for a button that is not on the
  // screen — the same class of falsehood the old guard existed to prevent,
  // only pointing the other way.
  const PORTAL_LABEL = "Manage billing or cancel";
  const manageBillingSource = readFileSync(
    path.join(repoRoot, "src/app/dashboard/manage-billing.tsx"),
    "utf8",
  );

  const faq = (fragment: string) => {
    const found = BILLING_FAQS.find((f) => f.q.toLowerCase().includes(fragment));
    expect(found).toBeDefined();
    return found!;
  };

  it("names a control the dashboard actually renders", () => {
    expect(manageBillingSource).toContain(PORTAL_LABEL);
  });

  it("points the cancellation term at the control, with email as fallback", () => {
    const body = term(CANCELLATION_ID).body;
    expect(body).toContain(PORTAL_LABEL);
    expect(body).toContain(SUPPORT_EMAIL);
  });

  it("points the support term at the control, with email as fallback", () => {
    const body = term(SUPPORT_ID).body;
    expect(body).toContain(PORTAL_LABEL);
    expect(body).toContain(SUPPORT_EMAIL);
  });

  // Ordering is substance here, not house style: the first route offered is
  // the one most customers take, and it has to be the self-serve one.
  it("answers 'how do I cancel' with the control first, email second", () => {
    const answer = faq("how do i cancel").a;
    expect(answer).toContain(PORTAL_LABEL);
    expect(answer).toContain(SUPPORT_EMAIL);
    expect(answer.indexOf(PORTAL_LABEL)).toBeLessThan(
      answer.indexOf(SUPPORT_EMAIL),
    );
  });

  it("answers 'how do I get an invoice' with the control first, email second", () => {
    const answer = faq("invoice").a;
    expect(answer).toContain(PORTAL_LABEL);
    expect(answer).toContain(SUPPORT_EMAIL);
    expect(answer.indexOf(PORTAL_LABEL)).toBeLessThan(
      answer.indexOf(SUPPORT_EMAIL),
    );
  });

  // Says WHERE the button is, not merely that it exists. "Click Manage
  // billing or cancel" is not an instruction if the customer cannot find the
  // screen it is on.
  it("says where the control lives", () => {
    for (const copy of [term(CANCELLATION_ID).body, faq("how do i cancel").a]) {
      expect(copy.toLowerCase()).toMatch(/\bdashboard\b/);
    }
  });

  // The anti-regression half. Restore the email-only wording and the cancel
  // and invoice copy stops naming the control at all — this fails then as
  // firmly as the old guard failed the reverse.
  it("never routes cancelling or invoices through email alone", () => {
    const routed = [
      term(CANCELLATION_ID).body,
      term(SUPPORT_ID).body,
      faq("how do i cancel").a,
      faq("invoice").a,
    ];
    for (const copy of routed) {
      expect(copy).toMatch(/manage billing/i);
    }
  });

  // Cancelling has to read as easy. Retention-desk phrasing is the failure
  // mode this catches: it turns a two-click action into a request we grant.
  it("does not phrase cancelling as a favour we have to grant", () => {
    const OBSTACLE_WORDING: ReadonlyArray<RegExp> = [
      /request cancellation/i,
      /cancellation request/i,
      /to request.{0,20}cancel/i,
      /contact (support|us).{0,30}to cancel/i,
    ];
    for (const copy of allCopyStrings()) {
      for (const wording of OBSTACLE_WORDING) {
        expect(copy).not.toMatch(wording);
      }
    }
  });

  it("names the support address wherever it asks the user to get in touch", () => {
    const asksForEmail = allCopyStrings().filter((c) => /email/i.test(c));
    expect(asksForEmail.length).toBeGreaterThan(0);
    for (const copy of asksForEmail) {
      expect(copy).toContain(SUPPORT_EMAIL);
    }
  });
});

describe("b-11: the pricing FAQ answers the three billing questions", () => {
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

  // An FAQ that says "yes, you can cancel" without saying how is not an
  // answer. These three assert the HOW, not the reassurance — and the HOW is
  // an email to a named address, which is a route that works today.
  it("tells the user how to cancel: by emailing the support address", () => {
    const cancelFaq = BILLING_FAQS.find((f) =>
      f.q.toLowerCase().includes("how do i cancel"),
    );
    expect(cancelFaq).toBeDefined();
    expect(cancelFaq!.a).toContain(SUPPORT_EMAIL);
  });

  it("gives an email fallback", () => {
    expect(answers().some((a) => a.includes(SUPPORT_EMAIL))).toBe(true);
  });

  // b-11 declares the FAQ answers "how to get an invoice". Cancelling and
  // post-cancellation access were already pinned above; the invoice question
  // was not asserted anywhere, on any surface other than /terms. Assert the
  // answer names a way to get one, not merely that invoices exist.
  it("tells the user how to get an invoice", () => {
    const invoiceFaq = BILLING_FAQS.find((f) =>
      f.q.toLowerCase().includes("invoice"),
    );
    expect(invoiceFaq).toBeDefined();
    expect(invoiceFaq!.a).toContain(SUPPORT_EMAIL);
  });

  it("repeats the refund position where the buying decision is made", () => {
    const joined = answers().toString().toLowerCase();
    expect(joined).toContain(NO_REFUNDS);
    expect(joined).toContain(END_OF_MONTH);
  });
});
