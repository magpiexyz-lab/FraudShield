-- 012_subscription_livemode.sql — which Stripe mode a subscription came from.
--
-- The Google Ads uploader refuses to send conversions from a table that mixes
-- Stripe TEST-mode and LIVE-mode subscriptions without a per-row flag, and it is
-- right to. The only candidate row it currently finds is a test-mode
-- subscription from 29 September that carries a real gclid — exactly the row
-- that must never reach Google Ads as a conversion. Reporting a test purchase
-- as revenue would corrupt the campaign's optimisation, not merely the count.
--
-- Stripe puts `livemode` on the EVENT, not just the object, so the webhook has
-- it for every type it handles and no extra API call is needed.
--
-- THREE-VALUED, and the third value carries meaning:
--
--   true   — a live-mode Stripe purchase. Uploadable.
--   false  — a test-mode Stripe purchase. Never uploadable.
--   NULL   — no Stripe purchase behind this row at all: a comped or free-tier
--            grant, inserted by hand. There is no mode to record because there
--            was no checkout.
--
-- NULL rather than a default, for the same reason 007 and 008 leave
-- current_period_start, price_cents and gclid NULL on comped rows: defaulting
-- would assert something about a row that no Stripe event ever touched. A
-- consumer should treat `livemode is not true` as "do not send", which fails
-- closed for both unknown and test rows.
--
-- BACKFILL. Every existing Stripe row is test mode, and that is provable rather
-- than assumed: src/app/api/checkout/route.ts has carried a live-key interlock
-- for the whole life of this project, refusing any key that is not sk_test_ or
-- rk_test_. No live checkout has ever been possible, so no live subscription
-- can exist. The statement below is therefore exact, not a guess — and it
-- deliberately touches only rows that have a Stripe subscription, leaving
-- comped grants NULL.
--
-- Additive only. No table is created, no column dropped or retyped, and
-- migrations 001-011 are untouched.

alter table public.subscriptions
  add column if not exists livemode boolean;

-- Backfill: see the note above on why false is exact for every existing row.
update public.subscriptions
  set livemode = false
  where stripe_subscription_id is not null
    and livemode is null;

-- The uploader filters on this column every run, alongside a mode check.
create index if not exists subscriptions_livemode_idx
  on public.subscriptions (livemode)
  where livemode is not null;

comment on column public.subscriptions.livemode is
  'Stripe mode this subscription was created in, taken from the webhook event''s livemode. true = live, false = test, NULL = no Stripe purchase behind the row (comped or free-tier grant). Consumers should treat `livemode is not true` as not-uploadable, which fails closed for both NULL and test rows.';
