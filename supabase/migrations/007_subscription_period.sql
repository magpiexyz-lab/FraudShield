-- 007_subscription_period.sql — make the Pro quota genuinely monthly.
--
-- The Pro plan is sold as "200 document scans / month" (src/app/pricing/plans.ts),
-- but usage was counted all-time: src/app/api/scan/route.ts counted every row in
-- `scans` with counts_toward_quota = true, with no date filter, and computeQuota
-- subtracted that from scan_quota. A subscriber therefore got 200 scans EVER, not
-- 200 per month — month two they paid again for zero remaining scans.
--
-- current_period_start is the billing anchor: the instant the subscription began.
-- The scan route rolls it forward in whole months to find the window that contains
-- now, and counts only scans created inside that window. Storing the anchor rather
-- than the live period means quota stays correct without depending on a renewal
-- webhook; when invoice.paid handling lands it can overwrite this with Stripes
-- authoritative period and the read path does not change.
--
-- Nullable and additive: existing rows (including comped accounts, which have no
-- Stripe subscription) keep NULL and fall back to all-time counting, which is the
-- correct behaviour for a lifetime grant.

alter table public.subscriptions
  add column if not exists current_period_start timestamptz;

comment on column public.subscriptions.current_period_start is
  'Billing anchor for the monthly scan quota. NULL means count all-time (free tier and comped grants). Written by the Stripe webhook at checkout.';
