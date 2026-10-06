-- Products whose store does not count stock (Salla `quantity: null`,
-- WooCommerce `manage_stock: false`, Shopify untracked inventory, Zid
-- `is_infinite`) used to sync as stock 0, so the order guard refused them as
-- sold out. NULL now means "not tracked"; `stock_status` stays the
-- availability signal. The default stays 0 so console/CSV products keep
-- their current meaning. No backfill: a store resync rewrites synced rows.
ALTER TABLE "products" ALTER COLUMN "stock" DROP NOT NULL;
