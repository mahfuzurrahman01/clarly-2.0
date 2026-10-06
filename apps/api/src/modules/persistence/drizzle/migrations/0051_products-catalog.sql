-- Feature 20 (Product Catalog & Stock): `products` — structured product
-- records for the AI agent to resolve customer product photos to live
-- price/stock.
--
-- Separate from KB documents: KB is chunked+vectorized for semantic search;
-- products are structured data with exact fields (price, stock, SKU). Mixing
-- them would force every price/stock query through vector search — slow and
-- unreliable for structured lookups.
--
-- `metadata` is the extensible JSON column for store-specific fields (Salla
-- product ID, Shopify variant ID, etc.) — populated by F24 store connectors.

CREATE TABLE IF NOT EXISTS "products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "name" text NOT NULL,
  "name_ar" text,
  "sku" text,
  "description" text,
  "description_ar" text,
  "price" numeric(12, 2) NOT NULL,
  "currency" text DEFAULT 'SAR' NOT NULL,
  "stock" integer DEFAULT 0 NOT NULL,
  "stock_status" text DEFAULT 'in_stock' NOT NULL,
  "image_url" text,
  "image_object_key" text,
  "category" text,
  "tags" text[] DEFAULT '{}',
  "metadata" jsonb DEFAULT '{}',
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "products_tenant_id_sku_unique" UNIQUE ("tenant_id", "sku")
);--> statement-breakpoint

ALTER TABLE "products"
  ADD CONSTRAINT "products_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "products_tenant_id_idx"
  ON "products" ("tenant_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "products_tenant_id_sku_idx"
  ON "products" ("tenant_id", "sku");--> statement-breakpoint

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "products_isolation" ON "products"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
