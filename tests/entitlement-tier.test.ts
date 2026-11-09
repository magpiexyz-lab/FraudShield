// b-13 — the three entitlement tiers, and the copy a scan-pack buyer reads.
//
// WHY A THIRD TIER NEEDED A NEW FUNCTION RATHER THAN A WIDER hasProAccess.
// b-13 says a pack buyer sees the single top reason a document was flagged.
// The obvious implementation is to teach hasProAccess about scan_credits, and
// it is the one thing that must not happen: hasProAccess is what computeQuota
// and scanWindowStart both read (src/lib/quota.ts), so widening it would hand
// every pack buyer the Pro monthly allowance AND a monthly billing window.
// Nothing decrements scan_credits -- consumption is implied by the all-time
// scan count -- so rolling that window forward re-grants the free scan and the
// entire purchased pack every month, for ever. That is the exact bug documented
// at src/lib/quota.ts:197-224, and it was fixed by moving scanWindowStart ONTO
// the predicate. entitlementTier therefore layers on top of hasProAccess and
// never widens it.
//
// tests/dashboard-quota-credits.test.ts asserts that intent as source text
// ("keeps the Pro breakdown gate on status alone"). A text assertion cannot
// see a widened predicate; the behavioural pair at the bottom of the first
// describe can, and that is why it is here.
//
// WHY scan_credits AND NOT credits_remaining. credits_remaining is CLAMPED to
// what is left (src/lib/quota.ts:117, Math.min(credits, remaining)), so a pack
// buyer who has spent every credit reads as 0 -- and would be demoted to the
// free tier on the very scan they paid for. scan_credits is cumulative and
// never decremented (src/app/api/webhooks/stripe/route.ts:246), which is the
// intended semantics: the tier means "has ever bought a pack", and it is
// permanent. User-approved decision, 2026-11-09.
//
// vitest runs environment "node" with no jsdom, so no surface can be rendered
// here. The tier rule is a pure function and the copy is a plain constant,
// which is the only level at which either is testable at all.

import { describe, it, expect } from "vitest";

import {
  entitlementTier,
  hasProAccess,
  type TierRow,
} from "@/lib/pro-access";
import {
  BILLING_FAQS,
  BILLING_TERMS,
  PACKS_DO_NOT_UNLOCK,
  PACKS_HEADING_AFTER_LOCK,
  PACK_TOP_REASON_NOTE,
} from "@/lib/billing-copy";
import type { SubscriptionsRow } from "@/lib/types";

/** The instant every case below is judged against. One clock, fixed. */
const NOW = new Date("2026-11-02T12:00:00.000Z");
const PAST = "2026-10-01T00:00:00.000Z";
const FUTURE = "2026-12-01T00:00:00.000Z";
/** One millisecond inside the window. The boundary is exclusive. */
const JUST_INSIDE = new Date(NOW.getTime() + 1).toISOString();
/** A row with a Stripe subscription behind it. */
const STRIPE_ID = "sub_1QabcdEFghijkLM";

/**
 * Defaults are the DANGEROUS shape: an EXPIRED comped grant that has bought
 * nothing. Its status is "active" for ever -- a comp is written by hand and no
 * webhook exists to flip a row Stripe never created -- so an implementation
 * that reads status, or that forgets the clock, calls this row "pro". It is
 * "free". Any case below that forgets to override lands here, and a careless
 * default therefore fails rather than passing by accident.
 */
const row = (over: Partial<TierRow> = {}): TierRow => ({
  status: "active",
  stripe_subscription_id: null,
  current_period_end: PAST,
  scan_credits: 0,
  ...over,
});

describe("entitlementTier", () => {
  const cases: ReadonlyArray<
    readonly [string, TierRow | null, "pro" | "pack" | "free"]
  > = [
    // THE DANGEROUS DEFAULT, asserted in its own right. An expired comp that
    // never bought a pack has paid nothing and holds nothing.
    ["an expired comp that bought nothing", row(), "free"],

    // THE PACK BUYER. The webhook deliberately leaves status alone when a pack
    // is bought (webhooks/stripe/route.ts:246), so this is what every pack
    // buyer's row looks like: inactive, no Stripe subscription, credits.
    [
      "an inactive row with credits",
      row({ status: "inactive", current_period_end: null, scan_credits: 5 }),
      "pack",
    ],

    // A real subscriber. Note the stale stored period end: Stripe is the
    // authority for a Stripe row, so the date must not demote them.
    [
      "an active Stripe subscription",
      row({ stripe_subscription_id: STRIPE_ID }),
      "pro",
    ],

    // ORDER MATTERS, AND THIS IS THE CASE THAT PROVES IT. Pro is tested
    // FIRST, so someone who subscribed and also once bought a pack is "pro",
    // not "pack". Testing credits first would demote a paying subscriber to
    // the one-reason view -- the headline paid feature, taken away by a $7
    // purchase they made months earlier.
    [
      "a Pro subscriber who also once bought a pack",
      row({ stripe_subscription_id: STRIPE_ID, scan_credits: 10 }),
      "pro",
    ],

    // A comp that has lapsed, from someone who then bought scans. They are
    // not Pro any more, but the pack is theirs.
    ["a lapsed comped grant with credits", row({ scan_credits: 3 }), "pack"],

    // Paid nothing, ever. The free tier sees no signal detail at all.
    [
      "no credits and no plan",
      row({ status: "inactive", current_period_end: null }),
      "free",
    ],

    // maybeSingle() returns null for a user who has never transacted. FAILS
    // CLOSED: a null row, and a read that failed and was defaulted to null,
    // must both be the cheapest tier.
    ["no row at all", null, "free"],

    // A comp inside its window is Pro, exactly as hasProAccess says.
    ["a comped grant inside its window", row({ current_period_end: FUTURE }), "pro"],
    [
      "a comped lifetime grant with no end date",
      row({ current_period_end: null }),
      "pro",
    ],

    // THE BOUNDARY, ASSERTED EXACTLY. current_period_end is the first instant
    // of the NEXT period -- what Stripe would bill on -- not the last instant
    // of this one, so a comp ending exactly now has ENDED. What it falls back
    // to depends only on whether a pack was ever bought.
    [
      "a comped grant ending at exactly this instant, with credits",
      row({ current_period_end: NOW.toISOString(), scan_credits: 2 }),
      "pack",
    ],
    [
      "a comped grant ending at exactly this instant, with none",
      row({ current_period_end: NOW.toISOString() }),
      "free",
    ],
    [
      "a comped grant one millisecond inside its window",
      row({ current_period_end: JUST_INSIDE }),
      "pro",
    ],

    // Status governs Pro first, whatever the dates say -- and a cancelled or
    // dunning subscriber who bought a pack still owns the pack.
    [
      "a canceled subscriber with credits",
      row({ status: "canceled", stripe_subscription_id: STRIPE_ID, scan_credits: 4 }),
      "pack",
    ],
    [
      "a canceled subscriber with no credits",
      row({ status: "canceled", stripe_subscription_id: STRIPE_ID }),
      "free",
    ],
    [
      "a past_due subscriber with credits",
      row({ status: "past_due", stripe_subscription_id: STRIPE_ID, scan_credits: 1 }),
      "pack",
    ],

    // STRICTLY GREATER THAN ZERO, not merely truthy and not merely non-zero.
    // scan_credits is a count written by a webhook from untyped JSON; a
    // negative value is corruption, and corruption must fail CLOSED rather
    // than buying a tier.
    [
      "a row whose credit count is zero",
      row({ status: "inactive", current_period_end: null, scan_credits: 0 }),
      "free",
    ],
    [
      "a row whose credit count is negative",
      row({ status: "inactive", current_period_end: null, scan_credits: -1 }),
      "free",
    ],

    // An unparseable comp date must not read as a lifetime grant: every
    // comparison against an Invalid Date is false, so Pro fails closed here
    // and the pack, if there is one, still stands.
    [
      "a comp whose end date cannot be parsed, with credits",
      row({ current_period_end: "not-a-date", scan_credits: 6 }),
      "pack",
    ],
    [
      "a comp whose end date cannot be parsed, with none",
      row({ current_period_end: "not-a-date" }),
      "free",
    ],
  ];

  it.each(cases)("%s -> %s", (_label, sub, expected) => {
    expect(entitlementTier(sub, NOW)).toBe(expected);
  });

  // Exact string match, for the same reason hasProAccess matches it exactly:
  // these rows arrive from Supabase as untyped JSON, and a lenient match would
  // quietly widen who counts as paid. Credits are present so that a row
  // wrongly judged Pro is distinguishable from one correctly judged pack.
  it("does not accept a loosely spelled status as Pro", () => {
    const as = (s: string) =>
      row({
        status: s as SubscriptionsRow["status"],
        current_period_end: null,
        scan_credits: 2,
      });
    expect(entitlementTier(as("Active"), NOW)).toBe("pack");
    expect(entitlementTier(as("ACTIVE"), NOW)).toBe("pack");
    expect(entitlementTier(as(" active"), NOW)).toBe("pack");
    expect(entitlementTier(as(""), NOW)).toBe("pack");
  });

  // THE INVARIANT tests/dashboard-quota-credits.test.ts:167-171 records as
  // source text, asserted where it is actually checkable. That test says
  // "hasProAccess must NOT start counting credits -- that gate answers a
  // different question", and it proves it by grepping for the identifier,
  // which a widened predicate would satisfy. This pair cannot be satisfied by
  // a widened predicate: the two functions must disagree about this row.
  it("adds the pack tier without widening the Pro predicate", () => {
    const packBuyer = row({
      status: "inactive",
      current_period_end: null,
      scan_credits: 5,
    });
    expect(hasProAccess(packBuyer, NOW)).toBe(false);
    expect(entitlementTier(packBuyer, NOW)).toBe("pack");
  });

  // The same invariant from the other side: the tier must agree with
  // hasProAccess on EVERY row where hasProAccess says yes, and must never be
  // the only thing that says Pro.
  it("says pro exactly when hasProAccess does", () => {
    for (const [label, sub] of cases) {
      expect(
        entitlementTier(sub, NOW) === "pro",
        `${label}: the tier and hasProAccess disagree about Pro. The tier must ` +
          `be a layer on the predicate, not a second copy of it.`,
      ).toBe(hasProAccess(sub, NOW));
    }
  });

  // IT TAKES A ROW AND A CLOCK, AND NOTHING ELSE. An arity of 2 is what stops
  // the tier being computed from a usage figure: credits_remaining is clamped
  // by scans used, so a tier that could see usage could demote a pack buyer on
  // the scan they paid for. The permanence of the tier is a property of its
  // inputs.
  it("decides from the row and the clock alone", () => {
    expect(entitlementTier.length).toBe(2);
  });
});

describe("the pack-tier sentence", () => {
  // WHY THIS SENTENCE EXISTS. On 6 Nov 2026 a customer bought two $7 packs
  // from the locked-signals panel believing they unlocked the signal
  // breakdown, and lost $14. b-13 now shows that cohort ONE reason -- beside
  // the same buy-another-pack button. "One pack bought one reason" is the
  // reading that costs them the next $7, so the sentence has to close it.
  it("names what has been revealed", () => {
    expect(PACK_TOP_REASON_NOTE).toMatch(/top reason/i);
  });

  it("says the rest comes with Pro", () => {
    expect(PACK_TOP_REASON_NOTE).toMatch(/\bPro\b/);
  });

  // THE LOAD-BEARING HALF. Naming Pro is not enough: the sentence has to say,
  // in the same breath, that another pack is not the cheaper route to the same
  // thing. It must mention the packs and refuse them.
  it("says another pack reveals nothing further", () => {
    expect(PACK_TOP_REASON_NOTE).toMatch(/pack/i);
    expect(PACK_TOP_REASON_NOTE).toMatch(/\bnot\b/i);
  });

  it("states no price, so it cannot drift from what we charge", () => {
    expect(PACK_TOP_REASON_NOTE).not.toMatch(/\$\d/);
  });

  // tests/no-unbuilt-claims.test.ts bans both of these across all of src/.
  // Asserted here too so a reword is caught against the sentence itself
  // rather than as one offender in a tree-wide list.
  it("claims no capability the engine does not have", () => {
    expect(PACK_TOP_REASON_NOTE).not.toMatch(/\bcross[- ]document/i);
    expect(PACK_TOP_REASON_NOTE).not.toMatch(
      /reconcile[sd]?\s+(?:across|between)\s+documents/i,
    );
  });

  // A SEPARATE CONSTANT, NOT A REWRITE OF THE FREE-TIER ONE. The two sentences
  // are shown to different people: PACKS_DO_NOT_UNLOCK sits under a LOCKED
  // panel and is read by someone who has seen nothing, and stays exactly right
  // for them.
  it("does not replace the free-tier sentence", () => {
    expect(PACK_TOP_REASON_NOTE).not.toBe(PACKS_DO_NOT_UNLOCK);
  });

  // BYTE-IDENTICAL PINS, and the reason they are spelled out in full here.
  // tests/packs-not-an-unlock.test.ts checks these two with regexes
  // (/scan/i, /\bPro\b/, /not|only/i), which a weakened reword still
  // satisfies: "do not reveal the FULL signal detail" passes every one of
  // them while conceding exactly the thing the customer lost $14 to. Equality
  // is the only assertion that cannot be reworded past.
  it("pins PACKS_DO_NOT_UNLOCK byte for byte", () => {
    // REWORDED 2026-11-09 ON THE MANAGER'S INSTRUCTION. This pin was added to
    // stop a reword; the reword is now the decision, so the pin is UPDATED
    // rather than deleted -- changing this sentence still takes a deliberate
    // edit in three files, which is the whole point of pinning it.
    //
    // WHY IT CHANGED. "They do not reveal the signal detail above" held for
    // as long as a scan pack bought nothing but scans. PACK_TOP_SIGNAL_COUNT
    // now shows a pack buyer two named reasons, and this is the sentence a
    // reader sees at the buy button, so it had started denying the thing the
    // purchase actually does.
    //
    // WHAT MUST NOT BE LOST. The sentence exists because of a 14 dollar refund
    // on 6 Nov 2026: a customer bought two packs from this panel expecting the
    // FULL per-signal breakdown -- every signal, its detail, its points. The
    // new wording still refuses that and still names Pro as the only route to
    // it. tests/packs-not-an-unlock.test.ts holds that clause with a guard a
    // weakening reword cannot pass; the regexes beside it cannot.
    expect(PACKS_DO_NOT_UNLOCK).toBe(
      "Scan packs show why each result was flagged. Only Pro shows the full breakdown.",
    );
  });

  it("leaves PACKS_HEADING_AFTER_LOCK byte-identical", () => {
    expect(PACKS_HEADING_AFTER_LOCK).toBe("Need more scans instead?");
  });

  // The established pattern for a sentence shown on one surface is a
  // standalone export; the terms and the FAQ are rendered in full, in order,
  // and an entry added to either would appear on /terms and /pricing. Their
  // lengths are pinned by tests/billing-terms.test.ts; pinned here too so the
  // reason is next to the new export.
  it("joins neither the billing terms nor the FAQ", () => {
    expect(BILLING_TERMS).toHaveLength(5);
    expect(BILLING_FAQS).toHaveLength(3);
  });
});
