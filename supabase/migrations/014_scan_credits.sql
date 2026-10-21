-- 014_scan_credits.sql — scans bought outright, outside any subscription.
--
-- WHY. A week of live checkout produced 8 real visitors who opened Stripe and
-- none who paid; the one who came back and told us why said the reason was
-- price. Intent is not the problem -- more than half of the people who hit the
-- paywall click through to checkout -- so the thing to change is what they are
-- asked to commit to, not the funnel in front of it. $60/month is a large first
-- purchase for someone with one document to check.
--
-- CUMULATIVE PURCHASED, NOT A REMAINING BALANCE. This column only ever goes up.
-- Remaining scans are computed as (free quota + scan_credits) minus scans used,
-- exactly as the free tier already works -- the scans table is the ledger, and
-- it always has been. A decrementing balance would introduce a second record of
-- the same fact, and the two would eventually disagree: a scan that failed
-- midway, a double-fired webhook, or a retried request would each move one
-- counter and not the other.
--
-- CREDITS DO NOT EXPIRE. No expiry column, and that is a decision rather than
-- an omission. An expiring pack needs a date on every grant, a sweep to apply
-- it, copy explaining it on the pricing page, and a support answer when someone
-- loses scans they paid for. The upside would be breakage revenue we have no
-- reason to want from a product still trying to prove people will pay at all.
--
-- ON THE SUBSCRIPTIONS TABLE, though a pack buyer is not a subscriber. The row
-- is already the one place per-user billing state lives -- plan, quota, Stripe
-- ids, attribution -- and the webhook already upserts it on user_id. A separate
-- table would mean a second read on the scan path to answer one integer, and
-- two sources of truth for "what is this user allowed to do".
--
-- NOT NULL DEFAULT 0, unlike the nullable columns added in 007-013. Those
-- record facts about a Stripe event that may not have happened; this is a
-- count, and the honest value for a user who has bought nothing is zero, not
-- unknown. It also keeps the quota arithmetic free of null handling on the
-- hottest read path in the product.
--
-- Additive only. No table is created, no column dropped or retyped, and
-- migrations 001-013 are untouched.

alter table public.subscriptions
  add column if not exists scan_credits integer not null default 0;

comment on column public.subscriptions.scan_credits is
  'Scans bought outright through a one-time purchase, cumulative and never expiring. Only ever increases; remaining scans are (free quota + scan_credits) minus scans used, with the scans table as the ledger. Zero means nothing bought, never unknown.';

-- Guards the webhook against ever writing a negative grant.
alter table public.subscriptions
  drop constraint if exists subscriptions_scan_credits_non_negative;
alter table public.subscriptions
  add constraint subscriptions_scan_credits_non_negative
  check (scan_credits >= 0);
