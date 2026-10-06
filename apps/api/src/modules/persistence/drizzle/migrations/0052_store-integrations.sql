-- Feature 24 (Store Integrations): connect AI agent to merchants' e-commerce
-- stores (Salla, Zid, Shopify) for live product queries and order creation.
--
-- Three tables:
--   store_connections  — per-tenant store links with OAuth credentials
--   store_webhook_events — idempotency log for store webhooks
--   store_sync_jobs — sync tracking for product/inventory syncs

CREATE TABLE IF NOT EXISTS "store_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "store_id" text NOT NULL,
  "store_name" text NOT NULL,
  "access_token" text NOT NULL,
  "refresh_token" text,
  "token_expires_at" timestamp with time zone,
  "store_url" text,
  "webhook_secret" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_synced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "store_connections_tenant_id_provider_store_id_unique" UNIQUE ("tenant_id", "provider", "store_id")
);--> statement-breakpoint

ALTER TABLE "store_connections"
  ADD CONSTRAINT "store_connections_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "store_connections_tenant_id_idx"
  ON "store_connections" ("tenant_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "store_connections_provider_idx"
  ON "store_connections" ("provider");--> statement-breakpoint

ALTER TABLE "store_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store_connections" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "store_connections_isolation" ON "store_connections"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "store_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider" text NOT NULL,
  "store_id" text NOT NULL,
  "event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb DEFAULT '{}' NOT NULL,
  "status" text DEFAULT 'received' NOT NULL,
  "processed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "store_webhook_events_provider_store_id_event_id_unique" UNIQUE ("provider", "store_id", "event_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "store_webhook_events_provider_store_id_idx"
  ON "store_webhook_events" ("provider", "store_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "store_sync_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "store_connection_id" uuid NOT NULL,
  "job_type" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "products_synced" integer DEFAULT 0,
  "products_updated" integer DEFAULT 0,
  "products_failed" integer DEFAULT 0,
  "error_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "store_sync_jobs"
  ADD CONSTRAINT "store_sync_jobs_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "store_sync_jobs"
  ADD CONSTRAINT "store_sync_jobs_store_connection_id_store_connections_id_fk"
  FOREIGN KEY ("store_connection_id") REFERENCES "public"."store_connections"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "store_sync_jobs_tenant_id_idx"
  ON "store_sync_jobs" ("tenant_id");--> statement-breakpoint

-- FK with no index would mean a Seq Scan of store_sync_jobs on every
-- store_connections delete cascade.
CREATE INDEX IF NOT EXISTS "store_sync_jobs_store_connection_id_idx"
  ON "store_sync_jobs" ("store_connection_id");--> statement-breakpoint

ALTER TABLE "store_sync_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "store_sync_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "store_sync_jobs_isolation" ON "store_sync_jobs"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
