-- Tenant offboarding, with a grace period.
--
-- Closing an account is the most destructive thing a tenant admin can do: 22
-- tables cascade from `tenants`, and the stored files and vector partition go
-- with them. None of it is recoverable, because the rows that name the storage
-- objects are deleted along with the objects themselves.
--
-- So closing is a two-step. `closed_at` cuts off access immediately and is
-- reversible. `purge_after` is when the data actually goes, and until that
-- moment a mistaken close — or a compromised admin session, which is a real
-- threat against exactly this endpoint — can still be undone.
--
-- Both nullable, both null for a live tenant: an open account has no closure
-- date and no scheduled erasure, and that must be representable rather than
-- encoded as a sentinel date.

ALTER TABLE "tenants"
  ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "tenants"
  ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint

-- The sweep asks one question on a schedule: which closed tenants are due?
-- Partial, because the overwhelming majority of rows are live tenants with a
-- null purge_after and have no business being in this index.
CREATE INDEX "tenants_purge_due_idx"
  ON "tenants" ("purge_after")
  WHERE "purge_after" IS NOT NULL;
