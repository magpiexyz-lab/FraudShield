-- =============================================================================
-- 015_api_waitlist_request_fields.sql
-- Turn the "Get API access" capture into something countable.
--
-- The dialog on /scan-result captured an email and nothing else, so a click
-- told us a number and never who was behind it. On 6 Nov one customer clicked
-- it twice in a day and we could not say what they wanted it for.
--
-- Three nullable columns, added to api_waitlist rather than a new table:
--   * every historical API-access row already lives here, and splitting the
--     record across two tables makes "how many requests have we had" a query
--     nobody will write correctly;
--   * the `source` column from 003 already segments API access from the
--     pro-upgrade waitlist, so the two uses stay separable;
--   * 003 set the precedent of extending this table additively.
--
-- All three are NULLABLE on purpose. Existing rows predate the form, and the
-- pro-upgrade source will never populate them — a NOT NULL here would mean
-- backfilling invented data into a table whose whole value is being honest
-- about demand.
--
-- monthly_volume holds the same coarse bands as enterprise_leads
-- (under-100 | 100-500 | 500-2000 | over-2000), enforced in the route by
-- VOLUME_BANDS rather than by a CHECK constraint, so the two surfaces cannot
-- drift to different scales. Stored as TEXT for the same reason 006 did:
-- a band is a label, not a number, and nobody knows their exact volume.
--
-- Additive + idempotent. No existing row changes, no policy changes. RLS
-- already restricts writes to the service role via /api/waitlist.
-- =============================================================================

alter table api_waitlist
  add column if not exists company text;

alter table api_waitlist
  add column if not exists role text;

alter table api_waitlist
  add column if not exists monthly_volume text;

comment on column api_waitlist.company is
  'Submitter-stated company name from the API access request form. Nullable: rows predating the form, and pro-upgrade waitlist rows, have none.';

comment on column api_waitlist.role is
  'Submitter-stated job role from the API access request form. Free text — we are measuring who asks, not validating titles.';

comment on column api_waitlist.monthly_volume is
  'Coarse band of documents per month: under-100 | 100-500 | 500-2000 | over-2000. Same scale as enterprise_leads.monthly_volume; enforced by VOLUME_BANDS in src/app/api/enterprise-lead/route.ts.';

-- Counting these is the point, and `source` is how an API request is told
-- apart from a pro-upgrade row. Partial index: the table also holds rows this
-- predicate excludes, and they are not what anyone is counting.
create index if not exists api_waitlist_source_created_at_idx
  on api_waitlist (source, created_at desc)
  where source is not null;

-- =============================================================================
-- Enforce the same limits in the database that the route enforces.
--
-- WHY THIS IS NOT BELT-AND-BRACES. api_waitlist's INSERT policy from 001 ends
-- in `or user_id is null`, and NEXT_PUBLIC_SUPABASE_ANON_KEY is inlined into
-- the browser bundle. Anyone can therefore POST to
-- /rest/v1/api_waitlist with user_id null and write a row without going
-- through /api/waitlist at all — past the zod caps, past the monthly_volume
-- enum, and past the per-IP rate limit. Three unconstrained TEXT columns on a
-- table reachable that way is free storage for anybody who looks.
--
-- Tightening that policy is the root fix and would also close `email` and
-- `source`, which are uncapped today. That changes an existing policy on a
-- live table, so it is a separate decision, deliberately not made here.
--
-- ON THE monthly_volume CHECK. 015 originally left this to VOLUME_BANDS in the
-- route so the two intake surfaces could not drift to different scales. The
-- CHECK reintroduces that drift risk — add a band in TypeScript, forget the
-- migration, and the insert fails in production. That is answered by a test
-- which parses this constraint and asserts it lists exactly VOLUME_BANDS, so
-- the drift fails in CI instead. A loud CI failure beats an uncapped column.
--
-- Safe on existing rows: all three columns were added nullable moments ago, so
-- every existing row holds NULL, and each CHECK admits NULL. Idempotent via
-- pg_constraint so re-running this file is harmless.
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'api_waitlist'::regclass
      and conname = 'api_waitlist_company_len'
  ) then
    alter table api_waitlist
      add constraint api_waitlist_company_len
      check (company is null or char_length(company) <= 120);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'api_waitlist'::regclass
      and conname = 'api_waitlist_role_len'
  ) then
    alter table api_waitlist
      add constraint api_waitlist_role_len
      check (role is null or char_length(role) <= 120);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'api_waitlist'::regclass
      and conname = 'api_waitlist_monthly_volume_band'
  ) then
    alter table api_waitlist
      add constraint api_waitlist_monthly_volume_band
      check (
        monthly_volume is null
        or monthly_volume in ('under-100', '100-500', '500-2000', 'over-2000')
      );
  end if;
end $$;
