-- 011_subscription_email_match.sql — a fallback join key for conversion upload.
--
-- 008 added `gclid`, which is the precise link between a paid subscription and
-- the ad click that produced it. It is also the fragile one: an ad blocker, a
-- stripped query string, a link copied without its parameters, or a purchase
-- made days later in a different browser all arrive with no click id at all.
-- Those sales are real revenue that the Google Ads upload currently cannot
-- attribute to anything, so the campaign is measured as worse than it is.
--
-- The email is the one identifier the customer supplies on both sides of that
-- join, so its hash is the fallback. Stored as a HASH and not the address
-- because a conversion upload has no need to carry a readable customer list,
-- and because the row is then useless to anyone who obtains it without already
-- knowing which address to test.
--
-- FORMAT: hex-encoded SHA-256 of the email after trim + lower-case, exactly 64
-- characters. Produced by hashEmailForMatching() in src/lib/email-hash.ts,
-- which is the single place that normalisation is defined; the check constraint
-- below only enforces the resulting SHAPE, because a database cannot verify
-- that a digest was taken over a correctly normalised input.
--
-- NULLABLE, and null is meaningful: no usable email was known at checkout.
-- Deliberately not defaulted, and deliberately not the digest of the empty
-- string — sha256('') is a real constant, so defaulting to it would write one
-- identical value onto every unmatched row and then join all of those customers
-- to each other. `where email_sha256 is null` finds them instead.
--
-- Additive only. No table is created, no column is dropped or retyped, and
-- migrations 001-010 are untouched.

alter table public.subscriptions
  add column if not exists email_sha256 text;

-- SHAPE ONLY. 64 lowercase hex characters, or NULL. Rejects the two mistakes
-- that would silently corrupt the join: a raw email address written into the
-- column, and an upper-case digest (hex is case-insensitive to read but not to
-- compare, so 'AB..' and 'ab..' would be two different keys for one customer).
alter table public.subscriptions
  drop constraint if exists subscriptions_email_sha256_hex;

alter table public.subscriptions
  add constraint subscriptions_email_sha256_hex
  check (email_sha256 is null or email_sha256 ~ '^[0-9a-f]{64}$');

-- The upload reads this column to find the sales that gclid could not explain,
-- so it is queried as a filter far more often than as a lookup.
create index if not exists subscriptions_email_sha256_idx
  on public.subscriptions (email_sha256)
  where email_sha256 is not null;

comment on column public.subscriptions.email_sha256 is
  'Hex SHA-256 of the trimmed, lower-cased account email. Fallback join key for Google Ads conversion upload when gclid is absent. NULL = no usable email at checkout; never the digest of the empty string. Produced by hashEmailForMatching() in src/lib/email-hash.ts.';
