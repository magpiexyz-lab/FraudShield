// Binding billing copy for FraudShield — the single source of truth for what
// the product promises a paying customer.
//
// Three surfaces render this text: the /terms page, the billing FAQ on
// /pricing, and the landing footer. One module is what stops them disagreeing;
// three copies of a refund promise is three different refund policies, and the
// customer will hold us to whichever they read.
//
// It is a plain module rather than copy inlined into components for a second
// reason: vitest runs with environment "node" and this project has no jsdom, so
// a rendered page cannot be asserted here. Text that makes a commercial
// promise has to be testable, so the promise lives somewhere a node test can
// read it (tests/billing-terms.test.ts).
//
// The price is DERIVED from PLAN_PRICES — the same server-authoritative
// constant /api/checkout charges on, and the one src/app/pricing/plans.ts
// derives its display price from. A hardcoded figure here would survive a
// price change and quietly become a promise we do not honour.

import { PLAN_PRICES } from "@/lib/types";

// Why this copy names an in-app control AND an email address: the self-serve
// billing portal now ships (src/app/dashboard/manage-billing.tsx, backed by
// /api/billing-portal), so "cancel any time" has a button behind it and the
// copy has to say so — a customer sent to email when two clicks would have
// done it has been given the slow route to something we sold as instant.
//
// The address stays as the stated fallback rather than being deleted: someone
// locked out of their dashboard still has to be able to stop the charge, and a
// binding term with only one route is a term that fails whenever that route
// does. Control first, email second, both real. The button label below is the
// one manage-billing.tsx actually renders; tests/billing-terms.test.ts pins
// them together so a rename on either side cannot ship alone.

/** Where billing questions go. Draft Labs owns the Stripe account. */
export const SUPPORT_EMAIL = "admin@draftlabs.org";

/**
 * The reply time we commit to in writing. Stated once here so that raising or
 * lowering it is a single edit — a promise we can actually keep on every
 * surface, rather than "24 hours" on one page and "a few days" on another.
 */
export const SUPPORT_RESPONSE_SLA = "two business days";

/** 6000 → 60. PLAN_PRICES stores integer cents. Sourced, never hardcoded. */
export const PRO_PRICE_MONTHLY_USD = Math.round(PLAN_PRICES.pro / 100);

/** The price as it appears in prose. Every surface interpolates this. */
export const PRO_PRICE_LABEL = `$${PRO_PRICE_MONTHLY_USD}/month`;

/** One numbered clause of the billing terms. */
export type BillingTerm = { id: string; heading: string; body: string };

/** One question-and-answer pair in the billing FAQ. */
export type BillingFaq = { q: string; a: string };

/**
 * The five things a paying customer is entitled to know, in the order they
 * become relevant: what the charge is, how to stop it, what stopping it does,
 * what it does not do, and who to ask. Rendered in full on /terms and quoted
 * from on /pricing and the landing footer.
 *
 * The refund clause is deliberately blunt. A vague refund policy reads as
 * generous and is then argued about later; this one says no, in advance.
 */
export const BILLING_TERMS: ReadonlyArray<BillingTerm> = [
  {
    id: "subscription",
    heading: "What you are charged",
    body: `FraudShield Pro is a monthly subscription at ${PRO_PRICE_LABEL}, billed in US dollars. It renews on the same day each month until you cancel it.`,
  },
  {
    id: "cancellation",
    heading: "Cancelling",
    body: `You can cancel at any time, yourself, in a couple of clicks: open your dashboard and click "Manage billing or cancel". It takes effect the moment you confirm — nobody has to approve it, and nothing will try to talk you out of it. If you cannot get into your dashboard, email ${SUPPORT_EMAIL} instead and we will cancel it for you and confirm within ${SUPPORT_RESPONSE_SLA}. There is no contract, no minimum term, and no cancellation fee.`,
  },
  {
    id: "access-after-cancellation",
    heading: "What happens when you cancel",
    body: "Cancelling stops the next renewal. Pro access continues to the end of the month you have already paid for — it does not stop immediately, and nothing is taken back from the month you are in.",
  },
  {
    id: "refunds",
    heading: "Refunds",
    body: "There are no refunds for the current month once it has been charged. Cancelling stops the next charge; it does not refund one that has already been taken.",
  },
  {
    id: "support",
    heading: "Invoices and support",
    body: `Your invoices are in the billing portal: open your dashboard, click "Manage billing or cancel", and every receipt on the account is there to download, addressed to your company if you set it up that way. Email ${SUPPORT_EMAIL} if you would rather we sent one, or for anything else — a billing question, a charge you do not recognise — and you will have a reply within ${SUPPORT_RESPONSE_SLA}.`,
  },
];

/**
 * The same obligations, compressed to the three questions people actually ask
 * before they pay. Rendered on /pricing next to the Pro card, because the
 * moment someone hesitates over the button is the moment "how do I get out of
 * this?" needs an answer — and the answer has to be a route they can take now,
 * not merely a promise that cancelling is allowed.
 */
export const BILLING_FAQS: ReadonlyArray<BillingFaq> = [
  {
    q: "How do I cancel?",
    a: `Yourself, in a couple of clicks: open your dashboard and click "Manage billing or cancel". It applies straight away — no form to find, nothing to justify, and no cancellation fee. Locked out of your dashboard? Email ${SUPPORT_EMAIL} and we will do it for you within ${SUPPORT_RESPONSE_SLA}.`,
  },
  {
    q: "What happens to my access if I cancel?",
    a: "Pro stays on until the end of the month you have already paid for, then your account drops back to the free tier. There are no refunds for a month that has already been charged.",
  },
  {
    q: "How do I get an invoice?",
    a: `Open your dashboard, click "Manage billing or cancel", and download any month you need yourself — addressed to your company if that is what your finance team wants. Or email ${SUPPORT_EMAIL} and we will send one within ${SUPPORT_RESPONSE_SLA}.`,
  },
];
