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

import type { EntitlementTier } from "@/lib/pro-access";
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

/**
 * Shown with the scan packs on the locked-signals panel, and only there.
 *
 * On 6 Nov 2026 a customer with two scans still unused bought two $7 packs
 * from this panel, expecting them to reveal the signal detail, and found the
 * same result still locked. The packs sat directly beneath "Unlock all N
 * forensic signals" under the heading "Or just buy the scans you need", so
 * "Or" read as a second, cheaper route to the same thing.
 *
 * Packs buy scans, and they now name the worst reasons behind a result. Only
 * Pro reveals the WHOLE of what a scan found. That distinction is obvious from
 * the inside and invisible from the outside, so it is stated at the point of
 * payment rather than left to be inferred from the layout.
 *
 * REWORDED 2026-11-09, ON THE MANAGER'S INSTRUCTION. It read: "Scan packs add
 * scans to your account. They do not reveal the signal detail above — only Pro
 * does." That stopped being true the day PACK_TOP_SIGNAL_COUNT gave a pack
 * buyer named reasons. This is the sentence a reader meets AT the buy button,
 * and it was denying the very thing the purchase does; a reader who catches us
 * understating what we sell has no reason to believe the next sentence either.
 *
 * WHAT THE REWORD KEPT, AND WHY IT HAD TO. The $14 was refunded for the FULL
 * per-signal breakdown — every signal, its detail, and the points it added —
 * not for a reason. The second clause still refuses that and still names Pro
 * as the only route to it, which is the load-bearing half of the sentence.
 * tests/packs-not-an-unlock.test.ts holds that clause against any further
 * reword (its three regexes cannot: they pass against a sentence that has
 * dropped it). The byte pins in tests/entitlement-tier.test.ts and
 * tests/pack-top-reason.test.ts keep changing this text a decision rather
 * than an edit.
 */
export const PACKS_DO_NOT_UNLOCK =
  "Scan packs show why each result was flagged. Only Pro shows the full breakdown.";

/**
 * Replaces the packs' default heading on the locked-signals panel. The default
 * is "Or just buy the scans you need", which is right on the dashboard, where
 * running out of scans is the only thing being refused. Here the word "Or"
 * offers an alternative to an unlock it cannot perform.
 */
export const PACKS_HEADING_AFTER_LOCK = "Need more scans instead?";

/**
 * Shown to a SCAN-PACK BUYER, beneath the reasons b-13 reveals to them.
 *
 * A different sentence for a different reader, and deliberately NOT the same
 * one as PACKS_DO_NOT_UNLOCK. That one is read by somebody who has been shown
 * nothing and is deciding whether to buy, so it describes what a pack does.
 * This one is read by somebody who has already bought and can see their
 * reasons -- the harder case, because the panel beside it still sells scan
 * packs, so "one pack bought two reasons" invites "two packs buy four".
 *
 * That misreading is expensive, and it has already happened. On 6 Nov 2026 a
 * customer bought two $7 packs from that panel expecting them to reveal the
 * signal detail, and lost $14. Showing that same cohort named reasons next to
 * the same button is a second invitation to make the same purchase, so this
 * sentence has to carry both halves: these are the top reasons, and the rest
 * comes with PRO -- not with more packs. The second half is load-bearing.
 *
 * PLURAL BUT NUMBERLESS, since 2026-11-09. PACK_TOP_SIGNAL_COUNT is 2 and the
 * note is printed ONCE, beneath the whole list, so the singular demonstrative
 * it shipped with ("This is the top reason") named the wrong number of things
 * it was sitting under. It states no number either: the count is a ceiling, a
 * one-signal scan shows one, and signalCountLabel is what reports how many
 * were actually rendered.
 *
 * It names no price, so it cannot drift from what we charge, and it claims
 * nothing about comparing documents (tests/no-unbuilt-claims.test.ts).
 */
export const PACK_TOP_REASON_NOTE =
  "These are the top reasons this document was flagged, worst first. The rest of the signal detail comes with Pro — another scan pack adds more scans, not more reasons.";

/**
 * Replaces PACKS_DO_NOT_UNLOCK for the reader who HAS been shown a reason.
 *
 * Both sentences sit in the same place -- beside the scan packs, under the
 * locked panel -- and only one of them is true of any given reader. The other
 * is written for somebody shown nothing who is deciding whether to buy, so it
 * describes what a pack DOES. Said instead to a pack buyer with their reasons
 * already on screen a few lines above, a description of the purchase is an
 * invitation to make it a second time.
 *
 * So this one answers the question that reader is actually asking, standing in
 * front of a buy button: what does the NEXT pack get me? More scans. Not
 * another reason. That half is load-bearing -- it is the inference that cost a
 * customer $14 on 6 Nov 2026 -- and it is the half PACK_TOP_REASON_NOTE also
 * carries, higher up the panel. Twice is deliberate: once beside the reason,
 * once beside the price.
 *
 * It does NOT soften to "not the FULL signal detail". That phrasing invites
 * precisely the inference it is meant to block -- that enough packs add up to
 * the rest -- and it reads as green against a test for the word "not".
 */
export const PACKS_DO_NOT_ADD_REASONS =
  "Scan packs add scans to your account. Another pack will not name another reason — the rest of the signal detail comes with Pro.";

/**
 * The clause that closes the /scan-result header, per reader.
 *
 * WHY THIS MOVED OUT OF THE JSX. It was one sentence, ungated: "Your score is
 * below; the signal-by-signal evidence behind it is part of Pro." Every reader
 * got it, including subscribers -- so the page told a paying Pro customer that
 * the breakdown printed in full further down was something they had yet to
 * buy. A pack buyer now has a third, different truth to be told, and three
 * readers is one too many for a sentence nothing can assert against: vitest
 * runs environment "node" here with no jsdom, so copy is only testable from a
 * module.
 *
 * `free` is byte-identical to the sentence that shipped. It is still exactly
 * right for a reader who can see nothing.
 *
 * `pack` went plural on 2026-11-09 with PACK_TOP_SIGNAL_COUNT. It closes the
 * page header, a long way above the panel, and a header promising "the top
 * reason" over a panel naming two leaves the same page telling one reader two
 * different things about what they bought -- the disagreement this module
 * exists to prevent. It states no number, because the count is a ceiling and a
 * one-signal scan shows one.
 */
export const SCORE_EVIDENCE_NOTE: Record<EntitlementTier, string> = {
  pro: "Your score and the signal-by-signal evidence behind it are both below.",
  pack: "Your score is below, and so are the top reasons it was flagged.",
  free: "Your score is below; the signal-by-signal evidence behind it is part of Pro.",
};

/**
 * The sentence under the "Forensic signal breakdown" heading, per reader.
 *
 * The free line ends "Pro shows you which", which is the second claim a pack
 * buyer can now disprove by reading three lines further down. Their version
 * says what IS there instead of what is missing; the note beneath the reason
 * itself (PACK_TOP_REASON_NOTE) handles what is still withheld, so saying it
 * twice here would only nag.
 *
 * "The most serious one" is the honest description of the ranking actually
 * used: src/lib/signal-rank.ts orders by severity first and weight second, so
 * the top-ranked signal is not necessarily the one that added the most points.
 * Copy calling it "the one that moved the score most" would be false whenever
 * a light fraud signal outranks a heavy suspect one.
 *
 * PLURAL SINCE 2026-11-09, when PACK_TOP_SIGNAL_COUNT rose to 2. This line
 * shares a heading row with signalCountLabel, so "The most serious one is
 * named below" beside a label reading "2 of 5 shown" would make one of the
 * two wrong. "Of them" rather than "the two", because the count is a ceiling:
 * a one-signal scan still shows one, and the sentence must stay true for it.
 * tests/pack-top-reason.test.ts pins the wording and the count together,
 * which is what forced this line to be re-read rather than left to rot.
 */
export const SIGNAL_BREAKDOWN_NOTE: Record<EntitlementTier, string> = {
  pro: "Every point in the score traces to a specific, inspectable signal.",
  pack: "Every point in the score traces to a specific, inspectable signal. The most serious of them are named below.",
  free: "Every point in the score traces to a specific, inspectable signal. Pro shows you which.",
};

/**
 * Which tier's sentences a reader actually gets.
 *
 * A pack buyer with no reason on screen is not a bug to be hidden: a clean
 * document produces no signals at all, and a malformed jsonb array can produce
 * none we are willing to name (see topNamedReasons). Either way the pack
 * sentences promise a reason that is not on the page, so such a reader is
 * handed the fully locked wording -- which is true for them, because they have
 * been shown nothing.
 *
 * PRO IS NEVER DEMOTED. Pro's rows come from SignalBreakdown, not from the
 * projection, so a zero count here says nothing about what Pro can see.
 *
 * AND NOBODY IS EVER PROMOTED. The count cannot raise a tier; it can only
 * withdraw a claim this page would otherwise make.
 */
export function tierForCopy(
  tier: EntitlementTier,
  reasonsShown: number,
): EntitlementTier {
  return tier === "pack" && reasonsShown < 1 ? "free" : tier;
}

/**
 * The count beside the "Forensic signal breakdown" heading.
 *
 * "5 signals" is a true statement of what the scan found and it is what free
 * and Pro readers see today -- unchanged here, because b-13 changes neither
 * view. Beside two readable reasons, though, it reads as a promise of five, to
 * the one cohort that has already paid us money and already once inferred more
 * than we delivered. "2 of 5 shown" is the same total, with the gap named.
 *
 * `shown` is the number of reasons ACTUALLY rendered, not PACK_TOP_SIGNAL_COUNT.
 * A count taken from the constant would claim a reason on a scan where the
 * projection produced none, and would read "2 of 1 shown" on a document with a
 * single signal -- promising a finding the scan never made.
 */
export function signalCountLabel(
  tier: EntitlementTier,
  total: number,
  shown: number,
): string {
  return tier === "pack" && shown > 0
    ? `${shown} of ${total} shown`
    : `${total} signals`;
}

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
