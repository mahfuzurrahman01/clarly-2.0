-- Clarly 2.0: routing tables for provider webhooks that arrive with no tenant.
--
-- Why: `courier_connections` and `store_connections` are FORCE ROW LEVEL
-- SECURITY. The webhook handlers resolved the tenant by reading those tables
-- through `runAdminQuery` with no `app.tenant_id` set, which under the
-- production role (non-superuser, NOBYPASSRLS, see docker/postgres-init)
-- returns ZERO rows — every courier push and every store webhook was rejected
-- as "unknown connection". These two tables are the pre-tenant routing key,
-- in the same shape as `whatsapp_numbers` and `stripe_customer_tenant_map`:
-- NOT RLS-scoped, no secrets, written inside the same `withTenantTx` that
-- activates or deactivates the connection, and read only to learn the tenant
-- — the connection itself (and its secret) is then loaded under that tenant.

CREATE TABLE IF NOT EXISTS "courier_routes" (
  "courier" text NOT NULL,
  "account_ref" text NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "courier_routes_pkey" PRIMARY KEY ("courier", "account_ref"),
  CONSTRAINT "courier_routes_connection_unique" UNIQUE ("connection_id")
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "store_routes" (
  "provider" text NOT NULL,
  "store_id" text NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "store_routes_pkey" PRIMARY KEY ("provider", "store_id"),
  CONSTRAINT "store_routes_connection_unique" UNIQUE ("connection_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "courier_routes_tenant_idx" ON "courier_routes" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "store_routes_tenant_idx" ON "store_routes" ("tenant_id");
