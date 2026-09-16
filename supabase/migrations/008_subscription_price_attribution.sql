-- 008_subscription_price_attribution.sql — what the subscription cost, and
-- which ad bought it.
--
-- `subscriptions` recorded that a user is on Pro, but not what they paid or
-- where they came from. The Stripe webhook already had all four values in hand
-- on checkout.session.completed — the session metadata carries gclid and
-- utm_campaign (written server-side by src/app/api/checkout/route.ts from
-- resolvePayIntentAttribution), and the amount is the same planAmount already
-- reported to analytics — it simply discarded them at the upsert. The result:
-- operations could not read the price from the database side at all, and a paid
-- subscription could not be traced back to the click that produced it.
--
-- price_cents is INTEGER CENTS, deliberately. pay_intent.price_cents
-- (004_pay_intent.sql) is already integer cents, so intent and conversion sum
-- in the same unit and a revenue query can join the two tables without a
-- rounding step or a silent 100x error. Do not "improve" this to numeric
-- dollars: it would put the two money tables in different units.
--
-- currency is the lowercase ISO-4217 code exactly as Stripe reports it on the
-- session ('usd'). Stored rather than assumed so the recorded amount is never
-- ambiguous about what it is denominated in, even though the checkout route
-- currently refuses to create a session whose Price is not usd.
--
-- gclid and utm_campaign are the paid-acquisition provenance. Together with
-- price_cents they make cost-per-acquisition answerable from the database
-- alone, instead of only from PostHog.
--
-- All four are NULLABLE and the migration is ADDITIVE: it only adds columns,
-- backfills nothing, and changes no existing row. Rows written before this
-- migration keep NULL, and so do comped accounts — those are lifetime grants
-- that never passed through Stripe, so there is no price and no purchase to
-- attribute. NULL there means "no purchase", which is the truth; a zero or an
-- empty string would be a claim we cannot support. Attribution is NULL for
-- organic purchases too, so "no attribution" stays queryable as `is null`
-- rather than hiding behind ''. The webhook normalises Stripe's empty-string
-- metadata to NULL for exactly this reason.

alter table public.subscriptions
  add column if not exists price_cents integer,
  add column if not exists currency text,
  add column if not exists gclid text,
  add column if not exists utm_campaign text;

comment on column public.subscriptions.price_cents is
  'Amount charged for this subscription, in INTEGER CENTS — same unit as pay_intent.price_cents so the two tables sum together. NULL for rows with no Stripe purchase behind them (comped grants, free tier). Written by the Stripe webhook at checkout.';

comment on column public.subscriptions.currency is
  'Lowercase ISO-4217 code as reported by Stripe on the Checkout Session (e.g. usd). Denominates price_cents. NULL when there was no Stripe purchase.';

comment on column public.subscriptions.gclid is
  'Google Ads click id that produced this purchase, relayed through the Checkout Session metadata. NULL for organic purchases and for comped grants — never an empty string.';

comment on column public.subscriptions.utm_campaign is
  'Campaign that produced this purchase, relayed through the Checkout Session metadata. NULL for organic purchases and for comped grants — never an empty string.';
