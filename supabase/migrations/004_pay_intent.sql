-- 004_pay_intent.sql — Google Ads Phase 2 fake-door value screen.
--
-- One row per "Upgrade to Pro" click by an activated user. Nobody is charged:
-- price_cents is the reference price we SHOWED, not an amount collected. This
-- table is the DB ground truth for the Phase 2 verdict, read by
-- .claude/scripts/lib/iterate_cross_phase2_db.py, which joins it to auth.users
-- for the email filter. Column names here are load-bearing for that reader.

create table if not exists public.pay_intent (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  -- PostHog distinct id, so a row can be tied back to its pay_intent event.
  distinct_id text,
  -- Paid-attribution relay. Both are nullable: an organic user has neither, and
  -- the day-0 probe carries a gclid the strict analytics sanitizer would refuse.
  -- Filtering paid from organic is the verdict pipeline's job, not this table's.
  gclid text,
  utm_campaign text,
  -- 'user_record' when the values came from the trusted server-persisted
  -- acquisition_* metadata, 'client' when they came from the browser at click
  -- time, 'none' when there was no attribution at all. Recorded because the
  -- client fallback is attacker-controllable — keeping the provenance means
  -- pollution stays detectable instead of silently entering the numerator.
  attribution_source text not null default 'none',
  price_cents int not null,
  created_at timestamptz default now()
);

comment on table public.pay_intent is
  'Google Ads Phase 2 fake-door pay-intent signal. No money changes hands — price_cents is the price shown. Writes are server-side only (service role).';

create index if not exists pay_intent_user_id_created_at_idx
  on public.pay_intent (user_id, created_at desc);

create index if not exists pay_intent_utm_campaign_idx
  on public.pay_intent (utm_campaign);

alter table public.pay_intent enable row level security;

-- Users may read their own intents. There are deliberately NO insert/update/
-- delete policies for clients: the /api/pay-intent route writes via the
-- service-role client, which bypasses RLS. A client-writable table would let
-- anyone forge the exact rows the Phase 2 verdict counts. Same shape as
-- `subscriptions` in 001_initial.sql — see .claude/stacks/database/supabase.md,
-- "When a table holds state-machine financial state, write policies must be
-- service-role-only".
drop policy if exists "pay_intent_select_own" on public.pay_intent;
create policy "pay_intent_select_own" on public.pay_intent
  for select using (auth.uid() = user_id);
