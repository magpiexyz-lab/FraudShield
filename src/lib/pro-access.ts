/**
 * Whether a subscription row entitles its owner to the paid surfaces.
 *
 * THE BUG THIS EXISTS FOR. The forensic signal breakdown on /scan-result
 * rendered its locked, blurred view whenever a scan had signals:
 *
 *   {fraudSignals.length > 0 ? <LockedSignals .../> : ...}
 *
 * There was no subscription check anywhere in that branch, and
 * SignalBreakdown -- the component that renders the real list -- was imported
 * nowhere. So "Per-signal breakdown & explanations", sold on the pricing page,
 * was invisible to everyone who paid for it.
 *
 * It surfaced on launch day when the first live subscriber reported that the
 * section still showed "You are already on Pro" above a locked panel. That
 * line comes from UpgradeCta, nested inside the locked view, which learns the
 * user is subscribed from checkout's 409 -- so the button knew and the section
 * around it did not.
 *
 * THE SECOND BUG, AND WHY THIS TAKES A ROW AND A CLOCK. The rule used to be
 * `status === ACTIVE` with no date in scope at all. Status is what revokes paid
 * access, and status is flipped by a WEBHOOK: customer.subscription.deleted
 * moves a real subscriber to canceled. A COMPED row has no webhook behind it --
 * it is written by hand -- so nothing ever revoked it. Every comp granted was a
 * grant of Pro for ever.
 *
 * WHY A FUNCTION RATHER THAN AN INLINE COMPARISON. vitest runs environment
 * "node" with no jsdom, so a component branch cannot be rendered in a unit
 * test. Pulling the rule out means the entitlement decision itself is tested
 * rather than the spelling of the code around it -- and an inline comparison
 * is exactly the shape of the thing that went missing in the first place. It
 * matters more now that the rule reads three columns instead of one: four
 * surfaces have to agree about who is Pro, and three of them cannot be
 * rendered in a test.
 */

import type { SubscriptionsRow } from "@/lib/types";

/** The one status string that grants paid access. */
const ACTIVE = "active";

/**
 * The columns the entitlement decision reads -- all of them, and nothing else.
 *
 * Named and exported so a read site can be typed on exactly what it must
 * select. Every one of these rows arrives from Supabase as untyped JSON, so the
 * type is a claim the caller makes rather than one the client proves; the
 * backstop is tests/entitlement-select-coverage.test.ts, which reads the actual
 * select strings.
 */
export type EntitlementRow = Pick<
  SubscriptionsRow,
  "status" | "stripe_subscription_id" | "current_period_end"
>;

/**
 * True when this row grants access to the paid surfaces at `now`.
 *
 * Three branches, in this order:
 *
 *   1. status must be exactly "active". Nothing else grants access.
 *   2. A row with a stripe_subscription_id is governed by status ALONE.
 *   3. Otherwise -- a comped grant -- it must not be past current_period_end.
 *      A NULL end date never expires.
 *
 * ACTIVE AND ONLY ACTIVE at step 1, matching computeQuota (src/lib/quota.ts)
 * and the checkout route's already-subscribed guard. The three agree
 * deliberately: a user who is Pro enough to be refused a second subscription
 * must be Pro enough to see what they bought.
 *
 * A PENDING CANCELLATION STILL COUNTS, and that is the point of gating on
 * status rather than on cancel_at_period_end. Someone who cancels has paid for
 * the current period and keeps access until it ends; only
 * customer.subscription.deleted moves status to canceled. Revoking the
 * breakdown the moment they click cancel would take away something already
 * paid for. It survives the new date branch for free: such a row has a
 * stripe_subscription_id, so step 2 decides it.
 *
 * `past_due` does NOT count. Their renewal payment failed, and Stripe's dunning
 * is still retrying; treating that as paid would hand out a month for free to
 * anyone whose card bounces.
 *
 * STRIPE IS THE AUTHORITY AT STEP 2, so a stored date can never revoke paid
 * access. current_period_end is refreshed by invoice.paid; a late, slow or
 * retried webhook leaves it stale while the customer is still being billed.
 * Expiring on it would take Pro away from a paying customer over OUR
 * bookkeeping lag -- so for a Stripe row the date is reporting, not a gate.
 * That is also why this keys on stripe_subscription_id, a FACT about the row,
 * and never on `plan`: a label says what someone meant, not what happened.
 *
 * A NULL END DATE STAYS PERPETUAL AT STEP 3. Migration 009 added the column and
 * backfilled nothing, so every comp granted to date is NULL-dated, and a
 * lifetime grant bills on no interval -- NULL is the truthful answer, not a
 * missing one (see the column comment in 009). Reading NULL as "expired" would
 * revoke every comped account in existence.
 *
 * THE BOUNDARY IS EXCLUSIVE: `end > now`. current_period_end is the first
 * instant of the next period -- the moment Stripe would bill -- not the last
 * instant of this one. An unparseable date also lands here as false, because
 * every comparison against an Invalid Date is false; a malformed value fails
 * CLOSED rather than being mistaken for a lifetime grant.
 */
export function hasProAccess(sub: EntitlementRow | null, now: Date): boolean {
  if (!sub || sub.status !== ACTIVE) return false;
  if (sub.stripe_subscription_id) return true;
  if (!sub.current_period_end) return true;
  return new Date(sub.current_period_end) > now;
}
