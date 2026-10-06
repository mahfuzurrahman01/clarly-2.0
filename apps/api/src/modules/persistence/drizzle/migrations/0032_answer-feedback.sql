-- SAAS_READINESS §8: thumbs up/down on an agent reply.
--
-- The cheapest collector for the eval corpus TODOS.md gates on real tenant
-- data. One rating per message per tenant: a second opinion replaces the
-- first, because "is this answer good" has one current answer, not a tally.
CREATE TABLE IF NOT EXISTS "answer_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"rating" text NOT NULL,
	"note" text,
	"rated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_feedback_tenant_id_message_id_unique" UNIQUE("tenant_id","message_id")
);--> statement-breakpoint
ALTER TABLE "answer_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "answer_feedback" ADD CONSTRAINT "answer_feedback_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "answer_feedback" ADD CONSTRAINT "answer_feedback_message_id_messages_id_fk"
    FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "answer_feedback" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "answer_feedback_isolation" ON "answer_feedback";--> statement-breakpoint
CREATE POLICY "answer_feedback_isolation" ON "answer_feedback"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
