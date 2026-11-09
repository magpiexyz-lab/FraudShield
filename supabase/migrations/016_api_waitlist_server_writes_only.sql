-- =============================================================================
-- 016_api_waitlist_server_writes_only.sql
-- Close the direct-write hole on api_waitlist.
--
-- THE HOLE. 001 gave this table an INSERT policy ending in `or user_id is null`:
--
--     create policy "api_waitlist_insert_authed" on api_waitlist
--       for insert with check (
--         (auth.uid() is not null and user_id = auth.uid())
--         or user_id is null
--       );
--
-- NEXT_PUBLIC_SUPABASE_ANON_KEY is inlined into the browser bundle, so that
-- second branch let ANYONE POST to /rest/v1/api_waitlist with user_id null and
-- write a row without going through /api/waitlist at all — past the zod schema,
-- past the length caps, past the per-IP rate limit. The table could be filled
-- with junk by anybody who read the bundle, and the waitlist is one of the two
-- demand signals this experiment is being judged on.
--
-- Found 2026-11-07 while adding the request-form columns in 015, which widened
-- the writable surface by three columns and prompted the review that caught it.
-- Manager approved closing it on 2026-11-09.
--
-- THE FIX. Drop the policy outright rather than narrowing it. With RLS enabled
-- and no INSERT policy, PostgREST refuses every client write regardless of role,
-- while the service-role client used by /api/waitlist bypasses RLS entirely and
-- is unaffected. "Only the app's own server writes here" is then enforced by the
-- absence of a policy, not by the correctness of a predicate — there is no
-- condition left to get wrong.
--
-- SAFE BECAUSE NOTHING CLIENT-SIDE INSERTS. The only insert anywhere in src/ is
-- the service-role one in src/app/api/waitlist/route.ts. Verified by grep across
-- src/ before writing this; tests/api-waitlist-server-only.test.ts pins it so a
-- future client-side insert fails loudly in CI rather than silently in
-- production.
--
-- FLOODING. Already handled in the route: rateLimit(`waitlist:${ip}`, 5, 60),
-- backed by Upstash Redis in production (verified live 2026-11-03). With the
-- direct path closed, that limiter is now the ONLY way in, so the cap it applies
-- is the cap on the table. No new limiter is needed and adding one would just be
-- a second thing to keep in sync.
--
-- SELECT is untouched: 001 deliberately gave this table no SELECT policy for
-- clients, so reads already go through the service role only.
--
-- Existing rows are not modified. Idempotent.
-- =============================================================================

drop policy if exists "api_waitlist_insert_authed" on api_waitlist;

-- Belt and braces: RLS must stay ON. Without it, dropping the policy would have
-- the exact opposite effect — Postgres applies no restriction at all to a table
-- with RLS disabled, so the "no policy means no writes" reasoning above depends
-- entirely on this line being true.
alter table api_waitlist enable row level security;

comment on table api_waitlist is
  'B2B integration interest capture (fake door). WRITES ARE SERVER-ONLY: there is deliberately no INSERT policy, so only the service-role client in /api/waitlist can write, rate-limited per IP. See 016.';
