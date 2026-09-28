-- 009_subscription_interval_period_end.sql -- how often it bills, and when the
-- current period ENDS.
--
-- After 007 and 008, public.subscriptions could answer "how much" (price_cents),
-- "in what currency" (currency), "what state is it in" (status) and "when did
-- the current period begin" (current_period_start). It could not answer the
-- other two questions asked of it: how often the subscription bills, and when
-- the current period ends. Neither was derivable from the row. The interval
-- existed only on the Stripe dashboard Price, and the period end only on the
-- Stripe Subscription object -- so any question about renewal timing meant a
-- round-trip to Stripe, and a report joining subscriptions to revenue had no
-- way to state the billing cadence it was summing over.
--
-- billing_interval is the recurring interval Stripe bills on: 'month' for the
-- Pro plan as sold today (src/app/pricing/plans.ts).
--
-- WHY billing_interval AND NOT interval: `interval` is a reserved type name in
-- PostgreSQL. A bare column of that name is legal but must be double-quoted in
-- essentially every context that touches it, and the failure mode of forgetting
-- is not a clean error -- the parser can read the bare word as the type and
-- produce a confusing complaint a long way from the real mistake. Prefixing it
-- sidesteps the whole class of quoting bug, and costs one word. Do not
-- "simplify" this back to interval.
--
-- billing_interval is DESCRIPTIVE, NOT AUTHORITATIVE. It records what was
-- billed; it does not enforce it. The binding check lives in
-- src/app/api/checkout/route.ts, which refuses to create a Checkout Session at
-- all unless the dashboard Price is recurring monthly, denominated in usd, and
-- has unit_amount exactly equal to PLAN_PRICES.pro. That guard is the reason a
-- mismatched Price never reaches a customer; this column is the record of what
-- the guard let through. Reading billing_interval to decide policy would be
-- reading the receipt instead of the contract.
--
-- current_period_end is the end of the current billing period exactly as Stripe
-- reports it, stored as an ISO timestamp. It is the partner of
-- current_period_start (007) and is refreshed alongside it whenever
-- invoice.paid rolls the subscription forward, so the two cannot drift into
-- describing a period that ends before it starts. Note that the scan quota
-- still derives from current_period_start, which the scan route rolls forward
-- in whole months on its own: that read path deliberately does not depend on a
-- renewal webhook having fired, and this column does not change it. This value
-- answers "when does this subscriber next get billed", not "how many scans are
-- left".
--
-- BOTH COLUMNS ARE NULLABLE and this migration is ADDITIVE: it adds two
-- columns, backfills nothing, and changes no existing row. NULL on either means
-- one of exactly two things -- the row predates this migration, or it is a
-- comped grant with no Stripe subscription behind it. A comped account is a
-- lifetime grant that never passed through Stripe, so it bills on no interval
-- and its period never ends; NULL is the truthful answer in both cases, and a
-- fabricated 'month' or a far-future date would be a claim we cannot support.

alter table public.subscriptions
  add column if not exists billing_interval text,
  add column if not exists current_period_end timestamptz;

comment on column public.subscriptions.billing_interval is
  'Recurring interval Stripe bills this subscription on, as Stripe reports it on the Price (e.g. month). Named billing_interval because interval is a reserved type name in PostgreSQL. DESCRIPTIVE ONLY -- the binding monthly/usd/amount check is in src/app/api/checkout/route.ts. NULL means the row predates the column or is a comped grant with no Stripe subscription.';

comment on column public.subscriptions.current_period_end is
  'End of the current billing period as reported by Stripe. Partner of current_period_start; refreshed together with it on invoice.paid so the pair cannot drift. Answers when the subscriber is next billed, not how much quota remains. NULL means the row predates the column, is a comped grant, or Stripe did not report a period end at checkout.';
