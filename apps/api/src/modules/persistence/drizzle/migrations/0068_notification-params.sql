-- QA 2026-10-05: notifications carry the values interpolated into their
-- English title/body, keyed per kind, so the console can localise them.
-- Nullable, no default, no backfill: adding a nullable column without a
-- default is a catalog-only change (no table rewrite, no long lock). Rows
-- written before this read back as params = {} and the console falls back to
-- the stored English title/body.
ALTER TABLE "notifications" ADD COLUMN "params" jsonb;
