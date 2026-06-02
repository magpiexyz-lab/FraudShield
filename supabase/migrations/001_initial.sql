-- FraudShield initial schema
-- Tables: scans, subscriptions, api_waitlist
-- All tables enable RLS — never trust the client.
--
-- IMPORTANT: raw uploaded documents are NEVER stored on the server. Only the
-- extracted metadata + computed signals + score are persisted in `scans`.

-- =============================================================================
-- scans
-- One row per document analyzed. Each row carries the forensic score (0-100),
-- a per-signal breakdown (jsonb), and file metadata (filename, mime, size,
-- PDF producer/creator/timestamps). Raw bytes are NOT stored.
-- =============================================================================

create table if not exists scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  doc_type text not null,
  fraud_score int not null check (fraud_score >= 0 and fraud_score <= 100),
  signals jsonb not null default '[]'::jsonb,
  file_meta jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);

comment on table scans is
  'Forensic fraud-detection results. Raw documents are not persisted — only metadata + signals + score.';

create index if not exists scans_user_id_created_at_idx
  on scans (user_id, created_at desc);

alter table scans enable row level security;

drop policy if exists "scans_select_own" on scans;
create policy "scans_select_own" on scans
  for select using (auth.uid() = user_id);

drop policy if exists "scans_insert_own" on scans;
create policy "scans_insert_own" on scans
  for insert with check (auth.uid() = user_id);

-- scans are never updated or deleted by users in the MVP. No UPDATE/DELETE policies
-- are intentional — PostgREST rejects mutations from authenticated callers, and
-- server-side maintenance flows would use the service-role client.

-- =============================================================================
-- subscriptions
-- One row per paying user (unique on user_id). Server-side flows (Stripe
-- webhook handler running with the service-role client) own writes. Owners may
-- read their own row to render the quota meter.
-- =============================================================================

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null unique,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  status text not null default 'inactive',
  plan text not null default 'free',
  scan_quota int not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

comment on table subscriptions is
  'Stripe-linked plan + quota per user. Writes are server-side only (webhook handler / service role).';

alter table subscriptions enable row level security;

drop policy if exists "subscriptions_select_own" on subscriptions;
create policy "subscriptions_select_own" on subscriptions
  for select using (auth.uid() = user_id);

-- NO insert/update/delete policies for clients. The Stripe webhook uses the
-- service-role client which bypasses RLS — see .claude/stacks/database/supabase.md
-- "When a table holds state-machine financial state, write policies must be
-- service-role-only".

-- =============================================================================
-- api_waitlist
-- Captures b-05 fake-door interest ("Get API access" → email capture).
-- Anonymous submissions are allowed (user_id may be null).
-- =============================================================================

create table if not exists api_waitlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  email text not null,
  created_at timestamptz default now()
);

comment on table api_waitlist is
  'B2B integration interest capture (fake door). Anonymous submissions allowed; service role writes from /api/waitlist.';

create index if not exists api_waitlist_created_at_idx
  on api_waitlist (created_at desc);

alter table api_waitlist enable row level security;

-- Authenticated users may register themselves; anonymous submissions write
-- via the service role (RLS bypassed) from /api/waitlist.
drop policy if exists "api_waitlist_insert_authed" on api_waitlist;
create policy "api_waitlist_insert_authed" on api_waitlist
  for insert with check (
    (auth.uid() is not null and user_id = auth.uid())
    or user_id is null
  );

-- No SELECT policy for clients — waitlist reads happen via the service role
-- (admin tooling, /iterate exports). Authenticated users have no need to read
-- the waitlist from the browser.
