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
 * WHY A FUNCTION RATHER THAN AN INLINE COMPARISON. vitest runs environment
 * "node" with no jsdom, so a component branch cannot be rendered in a unit
 * test. Pulling the rule out means the entitlement decision itself is tested
 * rather than the spelling of the code around it -- and an inline comparison
 * is exactly the shape of the thing that went missing in the first place.
 */

/** The one status string that grants paid access. */
const ACTIVE = "active";

/**
 * True when this subscription status grants access to paid surfaces.
 *
 * ACTIVE AND ONLY ACTIVE, matching computeQuota (src/lib/quota.ts) and the
 * checkout route's already-subscribed guard. The three agree deliberately: a
 * user who is Pro enough to be refused a second subscription must be Pro
 * enough to see what they bought.
 *
 * A PENDING CANCELLATION STILL COUNTS, and that is the point of gating on
 * status rather than on cancel_at_period_end. Someone who cancels has paid for
 * the current period and keeps access until it ends; only
 * customer.subscription.deleted moves status to canceled. Revoking the
 * breakdown the moment they click cancel would take away something already
 * paid for.
 *
 * `past_due` does NOT count. Their renewal payment failed, and Stripe's dunning
 * is still retrying; treating that as paid would hand out a month for free to
 * anyone whose card bounces.
 */
export function hasProAccess(status: string | null | undefined): boolean {
  return status === ACTIVE;
}
