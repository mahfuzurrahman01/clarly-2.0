-- A tenant's request for a copy of everything the platform holds about them.
-- GDPR Article 15, and a routine procurement ask.
--
-- Async by necessity: a busy workspace has hundreds of thousands of messages,
-- and assembling that inside a request/response cycle would time out on
-- exactly the tenants most likely to ask.

CREATE TABLE "data_exports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "requested_by" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "storage_key" text,
  "size_bytes" text,
  "row_counts" jsonb,
  "error" text,
  "expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);--> statement-breakpoint

ALTER TABLE "data_exports"
  ADD CONSTRAINT "data_exports_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "data_exports_tenant_created_idx"
  ON "data_exports" ("tenant_id", "created_at" DESC);--> statement-breakpoint

-- The expiry sweep's only question. Partial, because most rows have nothing
-- pending deletion.
CREATE INDEX "data_exports_expiry_idx"
  ON "data_exports" ("expires_at")
  WHERE "expires_at" IS NOT NULL AND "storage_key" IS NOT NULL;--> statement-breakpoint

-- T5 pattern — same FORCE + NULLIF guard as every prior RLS table.
ALTER TABLE "data_exports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "data_exports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "data_exports_isolation" ON "data_exports"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
