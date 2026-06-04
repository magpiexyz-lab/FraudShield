-- =============================================================================
-- 003_api_waitlist_source.sql
-- Bug #2: graceful Pro-upgrade UX when Stripe is unconfigured.
--
-- /api/checkout now returns a structured "not_configured" response when the
-- Stripe envs are placeholder/absent, and the Pro card on /pricing swaps to
-- an inline waitlist form that POSTs to /api/waitlist with
-- { email, source: "pro-upgrade" }.
--
-- The api_waitlist table (defined in 001_initial.sql) does not yet carry a
-- `source` column, so the existing waitlist insert silently dropped it.
-- This migration is additive + idempotent: it adds a nullable TEXT `source`
-- column without touching existing rows or policies. RLS already restricts
-- writes through the service role from /api/waitlist; no policy change.
-- =============================================================================

alter table api_waitlist
  add column if not exists source text;

comment on column api_waitlist.source is
  'Where the waitlist row originated. Examples: "api-access" (b-05), "pro-upgrade" (bug #2 — Stripe unconfigured Pro CTA fallback).';
