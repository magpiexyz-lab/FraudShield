-- 013_scan_token_usage.sql — what each scan actually cost in model tokens.
--
-- WHY. Cost per scan was an estimate derived from token arithmetic: roughly
-- five cents for a one-page document, so about $10 against $60 of revenue if a
-- Pro subscriber used all 200 of their monthly scans. Nobody had measured it.
-- The Anthropic API returns exact token counts on every response and we were
-- discarding them.
--
-- PER SCAN, NOT PER USER, though the question asked was per user. A scan row
-- already carries user_id, so per-user cost is a sum over these rows -- and the
-- reverse is not true: a per-user running total could not answer which document
-- types cost most, whether PDFs cost more than images, or what a scan cost on a
-- given day. Storing the finer grain loses nothing and keeps every later
-- question answerable.
--
-- NO COST COLUMN, DELIBERATELY. Only tokens and the model that produced them.
-- A dollar figure written at scan time freezes a rate that Anthropic can change
-- and that differs per model, so a stored cost silently becomes wrong and
-- nothing in the row says so. Tokens are a fact about the request; price is a
-- fact about the day you ask. Multiply at read time.
--
-- WHY THE MODEL IS STORED. The counts are meaningless without it. Input and
-- output are billed at different rates and both differ per model, so a row that
-- does not name its model cannot be priced at all once the model changes.
--
-- NULL MEANS NO BILLED CALL. Scans from before this migration, scans where no
-- API key was configured, and scans whose image could not be decoded never
-- reached the model. They are left NULL rather than zeroed: zero is a real
-- measurement meaning "called and billed nothing", which never happens, and
-- backfilling it would make free scans indistinguishable from unmeasured ones
-- in every average taken afterwards.
--
-- Additive only. No table is created, no column dropped or retyped, and
-- migrations 001-012 are untouched.

alter table public.scans
  add column if not exists input_tokens integer,
  add column if not exists output_tokens integer,
  add column if not exists model text;

comment on column public.scans.input_tokens is
  'Input tokens billed by the content-analysis call, as the API reported them. NULL when no billed call was made (pre-migration rows, no API key, undecodable upload) — NOT zero, which would be a measurement rather than an absence.';

comment on column public.scans.output_tokens is
  'Output tokens billed by the content-analysis call, including thinking tokens. NULL when no billed call was made.';

comment on column public.scans.model is
  'The model that produced the token counts on this row. Stored because input and output are billed at per-model rates, so the counts cannot be priced without it once the model changes.';

-- Cost reporting reads recent rows that have a billed call, so the index is
-- partial: rows with no measurement are never the subject of these queries and
-- would only make the index bigger.
create index if not exists scans_token_usage_idx
  on public.scans (created_at desc)
  where input_tokens is not null;
