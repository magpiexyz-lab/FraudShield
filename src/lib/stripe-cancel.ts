// Does a Stripe Subscription represent a cancellation the customer has ASKED
// for but which has not yet taken effect?
//
// This is a pure function on purpose. The decision it makes used to live inline
// in the webhook, where the only way to test it was to grep the handler's
// source for a field name — and that is exactly how the bug below shipped: the
// test asserted the handler read `cancel_at_period_end`, which pinned the wrong
// field in place instead of catching it. A function can be fed a real payload.
//
// THE FIELD TRAP, measured rather than assumed. A Billing Portal cancellation
// on API version 2026-07-29.dahlia reports:
//
//   "cancel_at":            1793254123   <- set, equals current_period_end
//   "cancel_at_period_end": false        <- NOT set
//   "canceled_at":          1790662169
//   "status":               "active"
//
// (evt_1UKuEJRamJuooj63TxSnsho6, captured from the live endpoint.) Stripe
// expresses "cancel when the paid month runs out" by scheduling `cancel_at` at
// the period end, and leaves `cancel_at_period_end` false. The SDK's type still
// declares the older field — `cancel_at_period_end: boolean` is right there in
// node_modules/stripe/cjs/resources/Subscriptions.d.ts — so reading it compiles
// cleanly and silently never matches. A type check cannot catch a field the API
// has stopped populating; only a real payload can.
//
// BOTH are read, not just the new one. `cancel_at_period_end` is still set by
// the API when a caller passes it explicitly, and older API versions still send
// it, so dropping it would trade this bug for its mirror image.

/** The only fields the decision depends on. Loose types so a raw webhook
 *  payload — where anything may be absent — can be passed straight in. */
export type CancellationFields = {
  cancel_at?: number | null;
  cancel_at_period_end?: boolean | null;
};

/**
 * True when the subscription is scheduled to end but has not ended yet.
 *
 * Deliberately says nothing about WHEN it ends or WHY. A cancellation set for
 * the period end and one set for an arbitrary future date are the same event
 * to a churn report: the customer has left. The end itself arrives separately,
 * as customer.subscription.deleted.
 */
export function isPendingCancellation(
  subscription: CancellationFields,
): boolean {
  // Explicit flag, still used by direct API calls and older API versions.
  if (subscription.cancel_at_period_end === true) return true;

  // Scheduled end date — what the Billing Portal actually sets. `typeof` rather
  // than a truthiness check: `cancel_at` is a Unix timestamp, and while 0 is
  // not a date Stripe would ever send, "is a number" is the honest question.
  return typeof subscription.cancel_at === "number";
}
