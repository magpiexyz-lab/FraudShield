-- 006_enterprise_leads.sql
--
-- Intake for the Enterprise tier on /pricing.
--
-- Enterprise is a conversation, not a checkout: volume, SLAs and integration
-- shape are negotiated, so the tier captures qualifying detail rather than a
-- payment. A mailto was the first cut, but it left the lead in one person's
-- inbox with nothing queryable behind it.
--
-- Separate from api_waitlist rather than reusing it with a source value: that
-- table holds an email and nothing else, and the whole point here is the
-- qualifying answers.

create table if not exists public.enterprise_leads (
  id uuid primary key default gen_random_uuid(),
  -- /pricing is behind the auth middleware, so a submitter is always signed in
  -- and their email is already on the user record — no need to re-ask for it.
  user_id uuid references auth.users(id) not null,
  company text,
  -- A coarse band rather than a number. Nobody knows their exact monthly
  -- volume, and a band is enough to tell a 50-document reviewer from a 5,000.
  monthly_volume text,
  message text,
  created_at timestamptz default now()
);

comment on table public.enterprise_leads is
  'Enterprise tier intake from /pricing. Writes are server-side only (service role) via /api/enterprise-lead.';

create index if not exists enterprise_leads_created_at_idx
  on public.enterprise_leads (created_at desc);

alter table public.enterprise_leads enable row level security;

-- Users may read their own submission back. No client INSERT/UPDATE/DELETE:
-- the route writes with the service-role client, same shape as pay_intent and
-- subscriptions. A client-writable lead table would let anyone forge rows in
-- the pipeline the sales follow-up works from.
drop policy if exists "enterprise_leads_select_own" on public.enterprise_leads;
create policy "enterprise_leads_select_own" on public.enterprise_leads
  for select using (auth.uid() = user_id);
