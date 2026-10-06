-- T4/T18: durable tenant-visible alerts. AlertingModule has been firing
-- structured alerts with zero subscribers since Feature 7 — a tenant whose
-- ticket sat unclaimed all night had no way to learn that happened.
--
-- `dedup_key` is unique per tenant and load-bearing: the stuck-ticket sweep
-- re-fires for the same ticket on every run, so without it one overnight
-- ticket produces a notification every few minutes until morning.
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"dedup_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_tenant_id_dedup_key_unique" UNIQUE("tenant_id","dedup_key")
);--> statement-breakpoint
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "notifications_isolation" ON "notifications";--> statement-breakpoint
CREATE POLICY "notifications_isolation" ON "notifications"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- The console's two reads: newest first, and the unread badge.
CREATE INDEX IF NOT EXISTS "notifications_tenant_created_idx"
  ON "notifications" ("tenant_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_tenant_unread_idx"
  ON "notifications" ("tenant_id")
  WHERE "read_at" IS NULL;
