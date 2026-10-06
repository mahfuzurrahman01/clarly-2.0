-- F25 (Orders in Chat + Complaints), D2/D10.
--
-- Three tables, all FORCE RLS: the per-tenant approval-mode switch, the order
-- of record, and its price-snapshotted line items.
--
-- Nothing here seeds `tenant_order_settings`. A tenant with no row is
-- `disabled` (D1.1) — the default is absence, and fail-closed is the point:
-- the failure mode this gate exists to prevent is a real order for real money
-- placed by a language model.
--
-- `orders` is authoritative (D4). `store_sync_status` is deliberately NOT part
-- of `orders_status_check` — an order's relationship with the customer must
-- not be hostage to a store provider's uptime.

CREATE TABLE IF NOT EXISTS "tenant_order_settings" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "mode" text NOT NULL DEFAULT 'disabled',
  "cod_enabled" boolean NOT NULL DEFAULT true,
  "approval_window_hours" integer NOT NULL DEFAULT 24,
  "auto_enabled_at" timestamptz,
  "auto_enabled_by" uuid,
  "auto_eligibility_snapshot" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_order_settings_mode_check"
    CHECK ("mode" IN ('disabled', 'human_approval', 'auto')),
  CONSTRAINT "tenant_order_settings_approval_window_check"
    CHECK ("approval_window_hours" BETWEEN 1 AND 168)
);--> statement-breakpoint

ALTER TABLE "tenant_order_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_order_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_order_settings_isolation" ON "tenant_order_settings";--> statement-breakpoint
CREATE POLICY "tenant_order_settings_isolation" ON "tenant_order_settings"
  AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "orders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "reference" text NOT NULL,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "conversation_id" uuid REFERENCES "conversations"("id") ON DELETE SET NULL,

  "status" text NOT NULL,

  "contact_name" text NOT NULL,
  "contact_phone" text NOT NULL,
  "city" text,
  "address" text NOT NULL,
  "notes" text,

  "payment_method" text NOT NULL DEFAULT 'cod',
  "payment_status" text NOT NULL DEFAULT 'unpaid',

  "subtotal" numeric(12,2) NOT NULL,
  "total" numeric(12,2) NOT NULL,
  "currency" text NOT NULL,

  "store_connection_id" uuid REFERENCES "store_connections"("id") ON DELETE SET NULL,
  "store_sync_status" text NOT NULL DEFAULT 'not_applicable',
  "external_order_id" text,
  "store_payment_url" text,
  "store_sync_attempts" integer NOT NULL DEFAULT 0,
  "store_sync_error" text,

  "idempotency_key" text NOT NULL,
  "content_hash" text NOT NULL,

  "approved_by" uuid,
  "approved_at" timestamptz,
  "rejected_reason" text,
  "customer_notified_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "orders_status_check"
    CHECK ("status" IN ('pending_approval','confirmed','rejected','expired',
                        'cancelled','fulfilled','failed')),
  -- D3: COD only, in phase 1 and enforced by the database, not by intent.
  CONSTRAINT "orders_payment_method_check" CHECK ("payment_method" IN ('cod')),
  CONSTRAINT "orders_payment_status_check"
    CHECK ("payment_status" IN ('unpaid','collected')),
  CONSTRAINT "orders_store_sync_status_check"
    CHECK ("store_sync_status" IN ('not_applicable','pending','synced','failed')),

  CONSTRAINT "orders_tenant_id_idempotency_key_unique" UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "orders_tenant_id_reference_unique" UNIQUE ("tenant_id", "reference"),
  -- Supports order_items' composite FK below.
  CONSTRAINT "orders_tenant_id_id_unique" UNIQUE ("tenant_id", "id")
);--> statement-breakpoint

-- D6.2 race #3: two racing turns in one conversation cannot open two identical
-- pending orders. `content_hash` excludes turnId on purpose.
CREATE UNIQUE INDEX IF NOT EXISTS "orders_pending_dedup_idx"
  ON "orders" ("tenant_id", "conversation_id", "content_hash")
  WHERE "status" = 'pending_approval';--> statement-breakpoint

-- D6.2 race #5 / D4.7: a double push cannot record two external ids.
CREATE UNIQUE INDEX IF NOT EXISTS "orders_store_external_id_idx"
  ON "orders" ("tenant_id", "store_connection_id", "external_order_id")
  WHERE "external_order_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "orders_tenant_status_created_idx"
  ON "orders" ("tenant_id", "status", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_tenant_conversation_idx"
  ON "orders" ("tenant_id", "conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_tenant_customer_idx"
  ON "orders" ("tenant_id", "customer_id");--> statement-breakpoint

ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "orders_isolation" ON "orders";--> statement-breakpoint
CREATE POLICY "orders_isolation" ON "orders"
  AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "order_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "order_id" uuid NOT NULL,
  -- SET NULL, not CASCADE: a product deleted later must not erase order history.
  "product_id" uuid REFERENCES "products"("id") ON DELETE SET NULL,

  "product_name" text NOT NULL,
  "sku" text,
  "unit_price" numeric(12,2) NOT NULL,
  "currency" text NOT NULL,
  "quantity" integer NOT NULL,
  "line_total" numeric(12,2) NOT NULL,
  "external_product_id" text,
  "external_variant_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "order_items_quantity_check" CHECK ("quantity" > 0),
  -- COMPOSITE FK, same trick as customer_labels: an item cannot be attached to
  -- another tenant's order even if an id leaks.
  CONSTRAINT "order_items_order_fk"
    FOREIGN KEY ("tenant_id", "order_id")
    REFERENCES "orders" ("tenant_id", "id") ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "order_items_tenant_order_idx"
  ON "order_items" ("tenant_id", "order_id");--> statement-breakpoint

ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_items" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "order_items_isolation" ON "order_items";--> statement-breakpoint
CREATE POLICY "order_items_isolation" ON "order_items"
  AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
