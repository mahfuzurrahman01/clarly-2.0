-- F10: structured data the agent collects from customers.
--
-- Two tables because `scope` decides what a value is true OF: an order number
-- belongs to one conversation, a delivery address belongs to the person.
-- Both cascade with their parent — a value whose conversation has been purged
-- (T16) teaches nothing.
--
-- `intake_fields` on agent_versions is versioned config, unlike the number
-- binding and document scope: it is rendered into the prompt, so it changes
-- how the agent behaves, and a rollback must restore it with the persona it
-- shipped alongside.
ALTER TABLE "agent_versions" ADD COLUMN IF NOT EXISTS "intake_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "conversation_intake" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"value" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_intake_conversation_id_field_key_unique" UNIQUE("conversation_id","field_key")
);--> statement-breakpoint
ALTER TABLE "conversation_intake" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "customer_attributes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"value" text NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_attributes_customer_id_field_key_unique" UNIQUE("customer_id","field_key")
);--> statement-breakpoint
ALTER TABLE "customer_attributes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "conversation_intake" ADD CONSTRAINT "conversation_intake_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "conversation_intake" ADD CONSTRAINT "conversation_intake_conversation_id_conversations_id_fk"
    FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_attributes" ADD CONSTRAINT "customer_attributes_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_attributes" ADD CONSTRAINT "customer_attributes_customer_id_customers_id_fk"
    FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "conversation_intake" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "conversation_intake_isolation" ON "conversation_intake";--> statement-breakpoint
CREATE POLICY "conversation_intake_isolation" ON "conversation_intake"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "customer_attributes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "customer_attributes_isolation" ON "customer_attributes";--> statement-breakpoint
CREATE POLICY "customer_attributes_isolation" ON "customer_attributes"
  AS PERMISSIVE FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "conversation_intake_conversation_idx"
  ON "conversation_intake" ("conversation_id");
