-- Gulf T8 (F23; D6, D11, D15b) — comment automation on Facebook page posts and
-- Instagram posts/Reels.
--
--   - `comment_events`: the ledger. unique(channel, comment_id) is the webhook
--     replay guard; the row also carries the D15b private-reply thread
--     (`thread_state` awaiting_reply -> replied, `conversation_id`).
--   - `comment_actions`: unique(comment_id, action), claimed BEFORE the Graph
--     call, so a replay or a retry never posts a second public reply or sends
--     a second private reply.
--   - `comment_automation_settings` / `comment_post_rules`: the tenant rules
--     (keyword/intent triggers, per-post enable, public reply template, caps).
--
-- All four are tenant tables written after tenant resolution, so all four get
-- the same ENABLE + FORCE + NULLIF policy as every other RLS table (see 0043).
-- Status/decision/action columns are text without CHECK constraints, matching
-- the rest of the schema: the TypeScript unions are the vocabulary.

CREATE TABLE IF NOT EXISTS "comment_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "channel" text NOT NULL,
  "channel_account_id" text NOT NULL,
  "comment_id" text NOT NULL,
  "post_id" text NOT NULL,
  "parent_id" text,
  "author_id" text NOT NULL,
  "author_name" text,
  "text" text NOT NULL,
  "media_product_type" text,
  "comment_created_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'received' NOT NULL,
  "skip_reason" text,
  "intent" text,
  "decision" text,
  "public_reply_text" text,
  "private_reply_text" text,
  "private_reply_recipient_id" text,
  "private_reply_message_id" text,
  "private_reply_sent_at" timestamp with time zone,
  "thread_state" text,
  "conversation_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comment_events_channel_comment_id_unique" UNIQUE ("channel", "comment_id")
);--> statement-breakpoint

ALTER TABLE "comment_events"
  ADD CONSTRAINT "comment_events_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "comment_events"
  ADD CONSTRAINT "comment_events_conversation_id_conversations_id_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id")
  ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "comment_events_tenant_created_idx"
  ON "comment_events" ("tenant_id", "created_at");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "comment_events_awaiting_reply_idx"
  ON "comment_events" ("tenant_id", "channel_account_id", "private_reply_recipient_id")
  WHERE "thread_state" = 'awaiting_reply';--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "comment_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "comment_event_id" uuid NOT NULL,
  "comment_id" text NOT NULL,
  "action" text NOT NULL,
  "status" text DEFAULT 'claimed' NOT NULL,
  "provider_ref" text,
  "error" text,
  "attempts" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comment_actions_comment_id_action_unique" UNIQUE ("comment_id", "action")
);--> statement-breakpoint

ALTER TABLE "comment_actions"
  ADD CONSTRAINT "comment_actions_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "comment_actions"
  ADD CONSTRAINT "comment_actions_comment_event_id_comment_events_id_fk"
  FOREIGN KEY ("comment_event_id") REFERENCES "public"."comment_events"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "comment_automation_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "post_scope" text DEFAULT 'all' NOT NULL,
  "reply_intents" jsonb DEFAULT '["purchase","question"]'::jsonb NOT NULL,
  "keyword_triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "spam_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "hide_spam" boolean DEFAULT true NOT NULL,
  "public_reply_template" text NOT NULL,
  "hourly_reply_cap_per_post" integer DEFAULT 30 NOT NULL,
  "hourly_reply_cap_per_tenant" integer DEFAULT 200 NOT NULL,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comment_automation_settings_tenant_id_unique" UNIQUE ("tenant_id")
);--> statement-breakpoint

ALTER TABLE "comment_automation_settings"
  ADD CONSTRAINT "comment_automation_settings_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "comment_post_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "channel" text NOT NULL,
  "channel_account_id" text NOT NULL,
  "post_id" text NOT NULL,
  "enabled" boolean NOT NULL,
  "public_reply_template" text,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "comment_post_rules_tenant_post_unique" UNIQUE ("tenant_id", "channel_account_id", "post_id")
);--> statement-breakpoint

ALTER TABLE "comment_post_rules"
  ADD CONSTRAINT "comment_post_rules_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "comment_post_rules_tenant_idx"
  ON "comment_post_rules" ("tenant_id");--> statement-breakpoint

ALTER TABLE "comment_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "comment_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "comment_events_isolation" ON "comment_events"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "comment_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "comment_actions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "comment_actions_isolation" ON "comment_actions"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "comment_automation_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "comment_automation_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "comment_automation_settings_isolation" ON "comment_automation_settings"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "comment_post_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "comment_post_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "comment_post_rules_isolation" ON "comment_post_rules"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
