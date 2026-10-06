-- Clarly 2.0 S4 (docs/v2/FEATURE_MATRIX.md, "Growth and messaging"): ported
-- from Autologic and rebuilt on Clarly's engine.
--   channel_pauses       — the bot is off on one channel account (Autologic's
--                          per-channel `bot_enabled`); inbound is still stored.
--   broadcasts           — free-form messages to people whose 24-hour window
--   broadcast_recipients   is open (no template, no Meta fee); sent by a queue
--                          worker, not by the browser as in Autologic.
--   followup_settings    — one automatic nudge to a quiet conversation, still
--   followups              inside the window. One row per (conversation, anchor)
--                          makes a double send impossible.
-- Every table is FORCE ROW LEVEL SECURITY with the standard policy.

CREATE TABLE IF NOT EXISTS "channel_pauses" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "channel_account_id" text NOT NULL,
  "paused_at" timestamptz NOT NULL DEFAULT now(),
  "paused_by" uuid,
  CONSTRAINT "channel_pauses_pkey" PRIMARY KEY ("tenant_id", "channel", "channel_account_id"),
  CONSTRAINT "channel_pauses_channel_check" CHECK ("channel" IN ('whatsapp', 'messenger', 'instagram', 'web'))
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "broadcasts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "message" text NOT NULL,
  "channels" text[] NOT NULL DEFAULT '{}',
  "segment_definition" jsonb,
  "status" text NOT NULL DEFAULT 'sending',
  "total" integer NOT NULL DEFAULT 0,
  "sent" integer NOT NULL DEFAULT 0,
  "failed" integer NOT NULL DEFAULT 0,
  "skipped" integer NOT NULL DEFAULT 0,
  "created_by" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "broadcasts_tenant_id_id_unique" UNIQUE ("tenant_id", "id"),
  CONSTRAINT "broadcasts_status_check" CHECK ("status" IN ('sending', 'completed', 'canceled', 'failed')),
  CONSTRAINT "broadcasts_message_check" CHECK (char_length("message") BETWEEN 2 AND 1000)
);--> statement-breakpoint
-- One broadcast at a time per workspace (Autologic's rule): predictable
-- sending and an honest count.
CREATE UNIQUE INDEX IF NOT EXISTS "broadcasts_one_sending_per_tenant" ON "broadcasts" ("tenant_id") WHERE "status" = 'sending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "broadcasts_tenant_created_idx" ON "broadcasts" ("tenant_id", "created_at" DESC, "id" DESC);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "broadcast_recipients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL,
  "broadcast_id" uuid NOT NULL,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "channel" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "skip_reason" text,
  "error" text,
  "message_id" uuid,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "claimed_at" timestamptz,
  "sent_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "broadcast_recipients_broadcast_fk" FOREIGN KEY ("tenant_id", "broadcast_id") REFERENCES "broadcasts"("tenant_id", "id") ON DELETE CASCADE,
  CONSTRAINT "broadcast_recipients_unique" UNIQUE ("broadcast_id", "conversation_id"),
  CONSTRAINT "broadcast_recipients_status_check" CHECK ("status" IN ('pending', 'sending', 'sent', 'failed', 'skipped'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "broadcast_recipients_queue_idx" ON "broadcast_recipients" ("broadcast_id", "status", "id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "followup_settings" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT false,
  "delay_hours" integer NOT NULL DEFAULT 20,
  "message" text NOT NULL,
  "audience" text NOT NULL DEFAULT 'interested',
  "updated_by" uuid,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "followup_settings_delay_check" CHECK ("delay_hours" BETWEEN 1 AND 22),
  CONSTRAINT "followup_settings_audience_check" CHECK ("audience" IN ('interested', 'all')),
  CONSTRAINT "followup_settings_message_check" CHECK (char_length("message") BETWEEN 2 AND 1000)
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "followups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "conversation_id" uuid NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  "anchor_inbound_at" timestamptz NOT NULL,
  "status" text NOT NULL,
  "skip_reason" text,
  "error" text,
  "message_id" uuid,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "followups_once_per_anchor" UNIQUE ("tenant_id", "conversation_id", "anchor_inbound_at"),
  CONSTRAINT "followups_status_check" CHECK ("status" IN ('sent', 'failed', 'skipped'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "followups_conversation_recent_idx" ON "followups" ("tenant_id", "conversation_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "followups_tenant_created_idx" ON "followups" ("tenant_id", "created_at" DESC);--> statement-breakpoint

ALTER TABLE "channel_pauses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "channel_pauses" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "channel_pauses_isolation" ON "channel_pauses" AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "broadcasts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcasts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "broadcasts_isolation" ON "broadcasts" AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "broadcast_recipients_isolation" ON "broadcast_recipients" AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "followup_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "followup_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "followup_settings_isolation" ON "followup_settings" AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "followups" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "followups" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "followups_isolation" ON "followups" AS PERMISSIVE FOR ALL
  USING ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
