-- Groundwork for replying to a customer from the console (SAAS_READINESS.md
-- §2). Data model only — no reply endpoint ships with this migration; the
-- columns exist so the pieces around a send (who sent it, whether it
-- arrived, whether the agent should stay quiet) are in place before the
-- send itself.
--
-- messages.author_user_id / conversations.handover_user_id are plain uuids,
-- NOT foreign keys: users live in Supabase's auth schema, outside this
-- database's own schema, and the rest of the app already references them
-- this way (tickets.assignee_id).
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "author_user_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "delivery_status" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "delivery_error" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "delivery_updated_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "handover_state" text NOT NULL DEFAULT 'agent';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "handover_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "handover_user_id" uuid;--> statement-breakpoint

-- A BSP status callback arrives with only the message id, so this is the
-- lookup path for every delivery update. Partial: inbound rows are never
-- matched this way, and the agent's own replies only gain an id once
-- delivery succeeds.
CREATE INDEX IF NOT EXISTS "messages_bsp_message_id_idx"
  ON "messages" ("bsp_message_id")
  WHERE "bsp_message_id" IS NOT NULL;
