-- F19 (docs/decisions/F19-campaigns-broadcast.md) — campaigns & broadcast,
-- first slice: schema, segment engine, consent split, campaign CRUD.
--
-- Journal entry for this file is added in the SAME commit
-- (meta/_journal.json idx 55) — migrations 0051/0052 shipped without one and
-- were silently never run by drizzle-orm's migrator. Do not repeat that.
--
-- No drizzle-kit snapshot file: this repo has not generated one since 0021
-- (migrations 0022+ are hand-written SQL + journal entries only), and
-- `drizzle-orm/node-postgres/migrator`'s runtime `migrate()` reads the
-- journal + SQL files, never the snapshots — those are only consumed by
-- `drizzle-kit generate`'s own diffing, which this repo has not relied on
-- for years of migrations.

-- ---- F19 Open Question 2: marketing consent split ----
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "marketing_opted_out_at" timestamp with time zone;--> statement-breakpoint

-- Every segment resolve carries the consent filter and pages by id; partial
-- index so opted-out rows (service OR marketing) are not in the index at
-- all.
CREATE INDEX IF NOT EXISTS "customers_tenant_active_idx"
  ON "customers" ("tenant_id", "id")
  WHERE "opted_out_at" IS NULL AND "marketing_opted_out_at" IS NULL;--> statement-breakpoint

-- tag hasAny -> tags @> / ?| ; jsonb_path_ops is the smaller, faster
-- containment index.
CREATE INDEX IF NOT EXISTS "customers_tags_gin_idx"
  ON "customers" USING gin ("tags" jsonb_path_ops);--> statement-breakpoint

-- last_inbound_within_days / last_inbound_before_days criteria.
CREATE INDEX IF NOT EXISTS "conversations_tenant_last_inbound_idx"
  ON "conversations" ("tenant_id", "last_inbound_at" DESC);--> statement-breakpoint

-- ---- D2: composite FK target on message_templates ----
ALTER TABLE "message_templates"
  ADD CONSTRAINT "message_templates_tenant_id_id_unique" UNIQUE ("tenant_id", "id");--> statement-breakpoint

-- ---- D4: WABA/business verification columns on whatsapp_numbers ----
-- Fed by the existing T5 daily reconcile's WABA read; no new job, no new
-- token. CampaignEligibilityService (D4) is not built in this slice — these
-- columns ship now so the reconcile can start populating them independently.
ALTER TABLE "whatsapp_numbers" ADD COLUMN IF NOT EXISTS "waba_account_review_status" text;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN IF NOT EXISTS "business_verification_status" text;--> statement-breakpoint

-- ---- D3: per-tenant default campaign spend cap ----
ALTER TABLE "tenant_policy" ADD COLUMN IF NOT EXISTS "campaign_default_spend_cap_usd" numeric(10, 2) DEFAULT '50' NOT NULL;--> statement-breakpoint

-- ---- D1: segments ----
CREATE TABLE IF NOT EXISTS "segments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "definition" jsonb NOT NULL,
  "last_resolved_count" integer,
  "last_resolved_at" timestamp with time zone,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "segments_tenant_id_name_unique" UNIQUE ("tenant_id", "name"),
  CONSTRAINT "segments_tenant_id_id_unique" UNIQUE ("tenant_id", "id")
);--> statement-breakpoint

ALTER TABLE "segments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "segments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "segments_isolation" ON "segments"
  AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ---- D2: campaigns ----
CREATE TABLE IF NOT EXISTS "campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "segment_id" uuid NOT NULL,
  "template_id" uuid NOT NULL,
  "template_values" jsonb NOT NULL DEFAULT '[]',
  "phone_number_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "scheduled_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "recipient_count" integer NOT NULL DEFAULT 0,
  "estimated_cost_usd" numeric(10, 2) NOT NULL DEFAULT 0,
  "spend_cap_usd" numeric(10, 2) NOT NULL,
  "spent_usd" numeric(10, 4) NOT NULL DEFAULT 0,
  "pause_reason" text,
  "failure_reason" text,
  "created_by" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "campaigns_tenant_id_id_unique" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "campaigns_spend_cap_positive" CHECK ("spend_cap_usd" > 0),
  CONSTRAINT "campaigns_status_check" CHECK ("status" IN
    ('draft', 'scheduled', 'sending', 'paused_spend_cap', 'paused_template',
     'completed', 'canceled', 'failed')),
  FOREIGN KEY ("tenant_id", "segment_id")
    REFERENCES "segments" ("tenant_id", "id") ON DELETE RESTRICT,
  FOREIGN KEY ("tenant_id", "template_id")
    REFERENCES "message_templates" ("tenant_id", "id") ON DELETE RESTRICT
);--> statement-breakpoint

ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaigns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "campaigns_isolation" ON "campaigns"
  AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- ---- D5: campaign_recipients ----
CREATE TABLE IF NOT EXISTS "campaign_recipients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "campaign_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "conversation_id" uuid,
  "message_id" uuid,
  "phone" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "skip_reason" text,
  "bsp_message_id" text,
  "delivery_status" text,
  "delivery_error" text,
  "cost_usd" numeric(10, 4),
  "attempt_count" integer NOT NULL DEFAULT 0,
  "sent_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "read_at" timestamp with time zone,
  "replied_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_recipients_campaign_id_customer_id_unique" UNIQUE ("campaign_id", "customer_id"),
  CONSTRAINT "campaign_recipients_status_check" CHECK ("status" IN
    ('pending', 'sending', 'sent', 'failed', 'skipped')),
  CONSTRAINT "campaign_recipients_delivery_status_check" CHECK ("delivery_status" IS NULL OR "delivery_status" IN
    ('sent', 'delivered', 'read', 'failed')),
  FOREIGN KEY ("tenant_id", "campaign_id")
    REFERENCES "campaigns" ("tenant_id", "id") ON DELETE CASCADE,
  FOREIGN KEY ("tenant_id", "customer_id")
    REFERENCES "customers" ("tenant_id", "id") ON DELETE CASCADE
);--> statement-breakpoint

ALTER TABLE "campaign_recipients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaign_recipients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "campaign_recipients_isolation" ON "campaign_recipients"
  AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "campaign_recipients_campaign_status_idx"
  ON "campaign_recipients" ("campaign_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaign_recipients_tenant_customer_sent_idx"
  ON "campaign_recipients" ("tenant_id", "customer_id", "sent_at" DESC);--> statement-breakpoint

-- Partial unique index for the delivery tracker's monotonic-status UPDATE
-- (D5). Not consumed by any code in this slice (CampaignDeliveryTracker is
-- part of the sender, out of scope here) but created now so the table shape
-- is complete and the sender slice is not also a migration.
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_recipients_bsp_message_id_idx"
  ON "campaign_recipients" ("bsp_message_id")
  WHERE "bsp_message_id" IS NOT NULL;
