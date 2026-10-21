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
    "status" | "scan_quota" | "scan_credits"
  > | null;
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
  const isPaid =
    input.subscription !== null &&
    input.subscription.status === "active";

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
