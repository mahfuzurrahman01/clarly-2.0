-- F11: outbound webhooks. The structured data F10 collects has had nowhere to
-- go; this is how it reaches the tenant's own system.
--
-- The signing secret is stored encrypted (same treatment as BSP credentials)
-- and never returned by a read path: a tenant sees it once, at creation.
CREATE TABLE IF NOT EXISTS "tenant_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"url" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_failure_at" timestamp with time zone,
	"last_failure_reason" text,
	"last_success_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "tenant_webhooks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "tenant_webhooks" ADD CONSTRAINT "tenant_webhooks_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "tenant_webhooks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_webhooks_isolation" ON "tenant_webhooks";--> statement-breakpoint
CREATE POLICY "tenant_webhooks_isolation" ON "tenant_webhooks"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
