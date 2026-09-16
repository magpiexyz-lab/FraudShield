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
  /** Active subscription row, or null if the user has no subscription */
  subscription: Pick<SubscriptionsRow, "status" | "scan_quota"> | null;
};

export type QuotaResult = {
  /** Whether the user is allowed to run another scan */
  allowed: boolean;
  /** Total quota available (free or subscription-based) */
  total_quota: number;
  /** Scans remaining (0 if exhausted) */
  remaining: number;
  /** Whether this user has an active paid subscription */
  is_paid: boolean;
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

  const totalQuota = isPaid
    ? input.subscription!.scan_quota
    : FREE_SCAN_QUOTA;

  const remaining = Math.max(0, totalQuota - input.scans_used);
  const allowed = remaining > 0;

  return {
    allowed,
    total_quota: totalQuota,
    remaining,
    is_paid: isPaid,
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
