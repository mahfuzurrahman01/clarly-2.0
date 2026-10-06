-- F12: message templates and canned replies.
--
-- The gap this closes: `customer-service-window.ts` has known since the human
-- reply shipped that Meta refuses free-form text after 24 hours, and the
-- console's only answer was a 409. A template is the only thing that sends
-- there, so without this table a human simply cannot reach a customer who
-- went quiet for a day — on exactly the conversations that most need it.
--
-- Cascades with the tenant: a template is tenant configuration, worth nothing
-- once the tenant is gone (T16 offboarding).
CREATE TABLE IF NOT EXISTS "message_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"category" text,
	"body" text NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approval_status" text DEFAULT 'local' NOT NULL,
	"approval_detail" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_templates_tenant_id_kind_name_language_unique" UNIQUE("tenant_id","kind","name","language")
);--> statement-breakpoint
ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "message_templates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "message_templates_isolation" ON "message_templates";--> statement-breakpoint
CREATE POLICY "message_templates_isolation" ON "message_templates"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- The console's picker filters by kind before anything else: canned replies
-- inside the window, approved WhatsApp templates outside it.
CREATE INDEX IF NOT EXISTS "message_templates_tenant_kind_idx"
  ON "message_templates" ("tenant_id", "kind");
