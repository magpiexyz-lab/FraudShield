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
