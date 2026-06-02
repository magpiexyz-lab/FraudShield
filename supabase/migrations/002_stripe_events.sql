-- Stripe webhook idempotency table.
-- The PRIMARY KEY on stripe_event_id is what makes the
-- "INSERT + catch PG 23505" pattern atomic — two concurrent deliveries of
-- the same event_id will produce exactly one successful insert; the other
-- receives 23505 and exits early with 200 so Stripe does not retry.
--
-- Only the service role writes to this table (the webhook handler uses
-- createServiceRoleClient). No client-facing access.

create table if not exists stripe_events (
  stripe_event_id text primary key,
  received_at timestamptz not null default now()
);

alter table stripe_events enable row level security;

drop policy if exists "service role writes stripe events" on stripe_events;
create policy "service role writes stripe events"
  on stripe_events
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
