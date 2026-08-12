-- 005_scans_counts_toward_quota.sql
--
-- A free scan should only be spent on a scan that produced a verdict.
--
-- Images whose AI content pass does not complete return a partial analysis:
-- real EXIF evidence, but no fraud score. Charging one of three free scans for
-- that is the product taking payment for a non-answer, and it lands hardest on
-- the users who photograph documents rather than exporting PDFs.
--
-- The rule is stored rather than derived so the quota query stays a plain
-- indexed count, and so the decision that was made about each scan is visible
-- in the data instead of being re-inferred from file_meta by every caller.
--
--   true  — PDF (always full document forensics), or an image whose vision pass
--           completed (file_meta.vision_analyzed = true)
--   false — an image that came back inconclusive or unavailable
--
-- Activation is deliberately NOT affected: a partial scan still shows real
-- signals, so it still counts as having used the product.

alter table if exists public.scans
  add column if not exists counts_toward_quota boolean not null default true;

comment on column public.scans.counts_toward_quota is
  'Whether this scan consumed one of the free-plan scans. False for partial image analyses, which return EXIF evidence but no fraud score.';

-- Backfill: retroactively refund partial image scans. Existing users get those
-- scans back, which is the same rule applied consistently rather than a
-- cut-off that would make two cohorts behave differently.
update public.scans
   set counts_toward_quota = false
 where file_meta->>'mime' like 'image/%'
   and coalesce(file_meta->>'vision_analyzed', 'false') <> 'true'
   and counts_toward_quota is distinct from false;

-- The quota check runs on every scan request, so keep it a covered index.
create index if not exists scans_user_id_counts_toward_quota_idx
  on public.scans (user_id) where counts_toward_quota;
