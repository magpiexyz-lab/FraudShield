/**
 * Free-scan quota gating logic.
 *
 * Determines whether a user has remaining scan quota based on:
 * 1. Their subscription status (active subscription → use subscription scan_quota)
 * 2. Their usage count (scans already run)
 * 3. The FREE_SCAN_QUOTA constant for unauthenticated / free-tier users
 *
 * Pure module — no I/O. The API route calls this after fetching scan counts
 * and subscription status from Supabase.
 */

import { hasProAccess, type EntitlementRow } from "@/lib/pro-access";
import { FREE_SCAN_QUOTA } from "@/lib/types";
import type { SubscriptionsRow } from "@/lib/types";

export type QuotaInput = {
  /** Number of scans already used by the user */
  scans_used: number;
  /**
   * The user's billing row, or null if they have none.
   *
   * Not necessarily a SUBSCRIPTION: someone who has only ever bought a
   * one-time scan pack has a row here with status "inactive" and a non-zero
   * scan_credits. The row is per-user billing state, not proof of a plan.
   */
  subscription: Pick<
    SubscriptionsRow,
    | "status"
    | "scan_quota"
    | "scan_credits"
    // THE ENTITLEMENT COLUMNS, both required. "Is this user paid?" is no longer
    // answerable from status alone: an active row with no Stripe subscription
    // is a COMPED grant, and a comp expires at its period end. Required rather
    // than optional because an absent current_period_end reads as "no end
    // date" and therefore as a lifetime grant -- a read site that forgot it
    // would hand out perpetual Pro and look fine doing it.
    | "stripe_subscription_id"
    | "current_period_end"
  > | null;
  /**
   * The instant to judge expiry against. Defaults to now.
   *
   * OPTIONAL ON PURPOSE, unlike hasProAccess's required `now`. There, omitting
   * the data is dangerous -- forgetting a column grants Pro for ever -- so the
   * signature forces every caller to think. Here the only risk of omission is
   * disagreeing about what time it is, and no caller has a reason to: all three
   * production callers pass an object literal and mean this instant. Requiring
   * it would be churn that buys no safety.
   */
  now?: Date;
};

export type QuotaResult = {
  /** Whether the user is allowed to run another scan */
  allowed: boolean;
  /** Total quota available (free + purchased credits, or subscription-based) */
  total_quota: number;
  /** Scans remaining (0 if exhausted) */
  remaining: number;
  /** Whether this user has an active paid subscription */
  is_paid: boolean;
  /**
   * Scans bought outright that are still unused.
   *
   * Reported separately from `remaining` so a surface can say "4 scans left"
   * to a pack buyer without claiming they are on a plan. Zero for subscribers:
   * their allowance is monthly, and a credit would have no meaning against it.
   */
  credits_remaining: number;
};

/**
 * Compute quota status for a user.
 *
 * @param input - scans_used count + subscription row (or null)
 * @returns QuotaResult — use `allowed` to gate the scan endpoint
 */
export function computeQuota(input: QuotaInput): QuotaResult {
  // THE ONE ENTITLEMENT RULE, shared with the scan-result paywall, the pricing
  // page and the checkout guard (src/lib/pro-access.ts). This used to be an
  // inline `status === "active"`, which gave a comped row -- active, with no
  // webhook behind it to ever flip that status -- the Pro monthly quota for
  // ever.
  const isPaid = hasProAccess(input.subscription, input.now ?? new Date());

  const credits = Math.max(0, input.subscription?.scan_credits ?? 0);

  // A SUBSCRIBER'S ALLOWANCE IS MONTHLY; CREDITS ARE PERMANENT. The two are
  // counted over different windows -- scans_used is reckoned from the current
  // billing period for a subscriber and all-time for everyone else -- so adding
  // them would compare quantities measured against different clocks and hand
  // out a few extra scans every month forever. Subscribers are blocked from
  // buying packs at checkout for the same reason; this is the second line of
  // defence, in case one ever arrives by a route we did not think of.
  const totalQuota = isPaid
    ? input.subscription!.scan_quota
    : FREE_SCAN_QUOTA + credits;

  const remaining = Math.max(0, totalQuota - input.scans_used);
  const allowed = remaining > 0;

  // How much of what is left was paid for rather than given away. Only
  // meaningful for a non-subscriber, and bounded by what is actually left:
  // someone who bought 5 and has 2 scans remaining has 2 paid scans remaining,
  // not 5.
  const creditsRemaining = isPaid ? 0 : Math.min(credits, remaining);

  return {
    allowed,
    total_quota: totalQuota,
    remaining,
    is_paid: isPaid,
    credits_remaining: creditsRemaining,
  };
}

/**
 * Add whole months to a UTC date, clamping the day-of-month so month-end anchors
 * do not skid forward. Plain `setUTCMonth(+1)` turns 31 Jan into 3 Mar, which would
 * silently hand a subscriber an extra billing window every short month.
 */
function addMonthsUTC(d: Date, months: number): Date {
  const day = d.getUTCDate();
  const r = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth() + months,
      1,
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds(),
    ),
  );
  const daysInMonth = new Date(
    Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0),
  ).getUTCDate();
  r.setUTCDate(Math.min(day, daysInMonth));
  return r;
}

/**
 * Start of the monthly billing window that contains `now`.
 *
 * The Pro plan sells "200 document scans / month", but usage used to be counted
 * all-time, so a subscriber got 200 scans EVER and month two was paid-for but
 * empty. Quota is now counted only from this instant forward.
 *
 * `anchor` is subscriptions.current_period_start — the moment the subscription
 * began. Rolling it forward in whole months keeps the quota correct without
 * depending on a renewal webhook having fired; when invoice.paid handling lands
 * it can overwrite the anchor with Stripe authoritative period and this read
 * path is unchanged.
 */
export function currentPeriodStart(anchor: Date, now: Date): Date {
  if (now <= anchor) return anchor;
  let months =
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - anchor.getUTCMonth());
  if (months < 0) months = 0;
  let start = addMonthsUTC(anchor, months);
  if (start > now) {
    start = addMonthsUTC(anchor, months - 1);
  } else {
    const next = addMonthsUTC(anchor, months + 1);
    if (next <= now) start = next;
  }
  return start;
}

/**
 * The instant from which the scans of a user should be counted, or null to
 * count all-time.
 *
 * Owns the billing-window decision for every read path -- /api/scan, the
 * dashboard meter and the scan-result paywall -- so the three cannot drift
 * apart again. The dashboard once counted all-time for everyone, which
 * over-counted the usage of an active subscriber; /api/scan hand-inlined this
 * rule, which is why the fix never reached the meter.
 *
 * Returns null when there is no row, when the row does not hold Pro, or when
 * no anchor is recorded. A NULL anchor means free tier or a comped lifetime
 * grant, where all-time counting is correct: the free card sells "1 document
 * scan, total", not one per month.
 *
 * GATED ON hasProAccess, THE SAME PREDICATE computeQuota USES, and sharing it
 * is the whole point. A quota is an allowance measured over a window:
 * computeQuota picks the allowance and this function picks the window. If the
 * two disagree about who is paid, the result is an allowance counted over the
 * wrong clock.
 *
 * That is not hypothetical -- it is the bug this gate was rewritten for. The
 * gate used to read status === "active" directly, which agreed with
 * computeQuota only by coincidence, and the coincidence ended when
 * computeQuota moved to hasProAccess. A COMPED row keeps status "active" for
 * ever, because a comp is written by hand and no webhook exists to flip a row
 * Stripe never created, so an EXPIRED comp was handed the free-tier allowance
 * by computeQuota and a MONTHLY window by this function. Nothing decrements
 * scan_credits -- consumption is implied solely by the all-time scan count --
 * so rolling the window forward re-granted the free scan and the entire
 * purchased pack every month, for ever.
 *
 * Status alone therefore cannot answer "is this user on a monthly billing
 * cycle". Only the predicate can, because only the predicate knows that a
 * Stripe-less active row is a comp and that a comp ends at its period end.
 *
 * The gate still does the work it was originally written for. The row is read
 * regardless of status (a pack buyer is "inactive"), and a CANCELLED
 * subscriber keeps their old current_period_start while currentPeriodStart()
 * rolls any anchor forward to the present -- so without a gate, someone who
 * cancelled and later bought a pack would have usage counted from this month
 * only and would be re-granted everything monthly. hasProAccess refuses that
 * row at its first branch, exactly as the old comparison did.
 *
 * TAKES THE ENTITLEMENT COLUMNS, all of them, for the same reason QuotaInput
 * does: an absent current_period_end reads as "no end date" and therefore as
 * a lifetime grant, so a read site that forgot it would quietly put an
 * expired comp back on a monthly window. Typed as EntitlementRow rather than
 * a hand-listed Pick so that if the predicate ever reads another column, this
 * signature follows it instead of silently passing undefined.
 */
export function scanWindowStart(
  sub: (EntitlementRow & Pick<SubscriptionsRow, "current_period_start">) | null,
  now: Date,
): Date | null {
  if (!sub || !hasProAccess(sub, now)) return null;
  if (!sub.current_period_start) return null;
  return currentPeriodStart(new Date(sub.current_period_start), now);
}
