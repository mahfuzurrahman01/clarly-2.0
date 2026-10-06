-- Cosmetic: switching tenant-policy.table.ts's confidenceThreshold column
-- to `mode: 'number'` (so callers get a JS number, not Postgres numeric's
-- default string) changed how drizzle-kit represents the column default at
-- the schema level; this normalizes the DB default to match. Same value
-- (0.7), no data migration needed.
ALTER TABLE "tenant_policy" ALTER COLUMN "confidence_threshold" SET DEFAULT 0.7;
