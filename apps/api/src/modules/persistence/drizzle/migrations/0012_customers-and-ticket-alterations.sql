-- `tickets.customer_id` is added NOT NULL with no default/backfill —
-- correct only because no tenant has real production data yet (this
-- product hasn't launched). If tickets ever exist in an environment this
-- runs against, backfill customer_id (via a data migration resolving each
-- ticket's phone number to a customers row) before this ALTER, or it will
-- fail outright.

CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"tags" jsonb DEFAULT '[]' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_tenant_id_phone_unique" UNIQUE("tenant_id","phone")
);
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "customer_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "confidence" numeric(3, 2);--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "cited_chunk_ids" jsonb;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_policy" ADD COLUMN "stuck_ticket_threshold_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;