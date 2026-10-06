-- Feature 24 (Store Integrations): WooCommerce becomes a supported provider,
-- and the last-sync read gets the index it needs.
--
-- 1. `store_connections.provider` has been a bare `text` column since 0052 —
--    the only thing keeping an unsupported value out was application code
--    (`STORE_PROVIDERS` / `isStoreProviderName`). Now that the provider list
--    is complete (Salla, Zid, Shopify, WooCommerce — the four
--    GULF_PARITY_PLAN's F24 line names), it is pinned in the database too, so
--    a future code path that forgets the check cannot write a connection no
--    adapter can serve. The constraint is added NOT VALID and then VALIDATEd
--    so the table is not held under an ACCESS EXCLUSIVE lock for the scan.
--
-- 2. `store_sync_jobs` finally has rows written to it (StoreSyncJobService),
--    and the read a tenant actually performs is "the latest job for THIS
--    connection". 0052's plain `(store_connection_id)` index serves the
--    delete cascade but leaves that query sorting; this composite matches it
--    exactly.
--
-- No data migration: every existing `store_connections` row already holds one
-- of the three previously-supported provider values, all of which are in the
-- new list, so the VALIDATE cannot fail on existing data.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'store_connections_provider_check'
  ) THEN
    ALTER TABLE "store_connections"
      ADD CONSTRAINT "store_connections_provider_check"
      CHECK ("provider" IN ('salla', 'zid', 'shopify', 'woocommerce'))
      NOT VALID;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "store_connections"
  VALIDATE CONSTRAINT "store_connections_provider_check";--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "store_sync_jobs_connection_recent_idx"
  ON "store_sync_jobs" ("tenant_id", "store_connection_id", "created_at" DESC);
