-- 010_subscription_cancel_pending.sql -- a cancellation that has been
-- REQUESTED but has not taken effect yet.
--
-- WHY THIS EXISTS -- a real production incident, not a hypothetical. A
-- customer cancelled through the Stripe billing portal on the live site.
-- Stripe emitted TWO customer.subscription.updated events and NO
-- customer.subscription.deleted, because a portal cancellation only sets
-- cancel_at_period_end = true and leaves the subscription ACTIVE until the
-- paid month runs out. customer.subscription.deleted does not arrive until
-- the period actually elapses, up to 30 days later. Before this migration the
-- row had nowhere to put that fact: it stayed status = active, looking exactly
-- like a happy subscriber, and the subscription_canceled analytics event did
-- not fire for up to a full billing period.
--
-- TWO COLUMNS, DELIBERATELY. They answer two different questions and neither
-- one alone is sufficient.
--
-- cancel_at_period_end is the PENDING FLAG, and it is also the IDEMPOTENCY
-- KEY for reporting the cancellation. Stripe sent two .updated events seconds
-- apart for one cancellation, and .updated also fires for entirely unrelated
-- reasons (price change, card update, quantity change). The stripe_events
-- table (002_stripe_events.sql) cannot dedupe that: it keys on the Stripe
-- event id, and those two deliveries carried DIFFERENT ids. So the webhook
-- derives exactly-once from ROW STATE instead -- it reports the cancellation
-- only when this column is not already true. That makes the column
-- load-bearing for correctness, which is why it is NOT NULL DEFAULT FALSE and
-- not nullable: a three-valued flag would make 'not cancel_at_period_end'
-- evaluate to NULL for every pre-existing row and silently disable the guard.
-- false is the truthful value for every row that predates this migration, for
-- the free tier, and for comped grants -- none of them has a cancellation
-- pending. Unlike 007/008/009, there is no such thing here as not knowing:
-- either we have recorded a pending cancellation or we have not.
--
-- canceled_at is WHEN the customer decided to leave, as Stripe reports it on
-- the Subscription. It is the fact the bug destroyed: without it, churn can
-- only be dated from the day ACCESS ended (current_period_end, 009), which
-- lags the decision by up to a billing period -- exactly the month-long lag
-- this change exists to remove. NULLABLE because NULL means no cancellation
-- has ever been requested, which has no date; a fabricated timestamp would be
-- a claim we cannot support. It is deliberately NOT cleared when a customer
-- reverses a pending cancellation in the portal: the boolean carries the
-- pending state, so retaining the timestamp costs no correctness and keeps the
-- only record that this subscriber was at risk and was saved. Do not tidy it
-- back to NULL.
--
-- NEITHER COLUMN TOUCHES status. A pending cancellation must NOT end ACCESS:
-- the customer has paid for the current period and the published terms
-- (src/app/terms/page.tsx) promise access to the end of it. computeQuota
-- (src/lib/quota.ts) gates on status = active, so writing status = canceled
-- here would revoke a paid month immediately and contradict those terms.
-- customer.subscription.deleted stays the only signal that access has actually
-- ended, and the only place status becomes canceled.
--
-- ADDITIVE: this migration adds two columns, backfills nothing and rewrites no
-- existing value. The default is a constant, so PostgreSQL applies it as
-- catalogue metadata without rewriting the table.

alter table public.subscriptions
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists canceled_at timestamptz;

comment on column public.subscriptions.cancel_at_period_end is
  'True when the customer has requested cancellation and ACCESS CONTINUES to the end of the paid period. Mirrors Stripe Subscription.cancel_at_period_end. NOT NULL DEFAULT FALSE because the Stripe webhook reads it as the exactly-once guard for the subscription_canceled event: Stripe sends several customer.subscription.updated events per cancellation, each with a different event id, so the stripe_events table cannot dedupe them and idempotency has to come from this row. Never implies loss of access -- only customer.subscription.deleted sets status to canceled.';

comment on column public.subscriptions.canceled_at is
  'When the customer REQUESTED cancellation, from Stripe Subscription.canceled_at. Dates churn from the decision rather than from the day access ended (current_period_end), which lags it by up to a billing period. NULL means no cancellation has ever been requested. Deliberately retained when a pending cancellation is reversed, so a saved subscriber stays visible; cancel_at_period_end is what carries the pending state.';
