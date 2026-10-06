-- QA 2026-10-05: audit entries carry a stable key for their description and
-- the values interpolated into it, beside the English `detail`, so the
-- console can localise the audit log. Both nullable with no default, so this
-- is a catalog-only change (no rewrite, no long lock) and needs no backfill:
-- existing and seeded rows read back with detailKey/detailParams = null.
-- No policy change: audit_log stays SELECT + INSERT only (migration 0037).
ALTER TABLE "audit_log" ADD COLUMN "detail_key" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "detail_params" jsonb;
