-- Feature 16 (T22) — Multi-channel messaging: Facebook Messenger + Instagram DM.
--
-- Three changes, one theme: "which channel" becomes part of an identity
-- rather than an assumption.
--
-- 1. `social_channels` — the Meta sibling of `whatsapp_numbers`. Same
--    resolution + encrypted-credential pattern, same deliberate absence of
--    RLS on the resolution read path (page_id/ig_id -> tenant_id is HOW
--    tenant context gets established for an inbound Meta webhook, so it is
--    necessarily read before any context exists). Plus the token lifecycle
--    columns Feature 16 requires: an expiring page token must degrade ONE
--    channel to a visible "reconnect needed" state, never silently drop a
--    tenant's messages.
--
-- 2/3. `conversations.channel` / `customers.channel`, folded into their
--    uniqueness constraints. A Messenger PSID and a WhatsApp number are both
--    digit strings; without the channel in the key, a colliding pair would
--    silently merge two different people. Both default to 'whatsapp', which
--    is exactly what every pre-Feature-16 row is — no backfill guess.

CREATE TABLE IF NOT EXISTS "social_channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "channel" text NOT NULL,
  "channel_account_id" text NOT NULL,
  "page_id" text NOT NULL,
  "display_name" text,
  "credentials_encrypted" text NOT NULL,
  "token_expires_at" timestamp with time zone,
  "token_refreshed_at" timestamp with time zone,
  "connection_state" text DEFAULT 'connected' NOT NULL,
  "connection_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "social_channels_channel_account_id_unique" UNIQUE("channel_account_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "social_channels_tenant_id_idx" ON "social_channels" ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "social_channels_token_expires_at_idx" ON "social_channels" ("token_expires_at");--> statement-breakpoint

ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "channel" text DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint

ALTER TABLE "conversations"
  DROP CONSTRAINT IF EXISTS "conversations_tenant_id_customer_phone_unique";--> statement-breakpoint

ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_tenant_id_customer_phone_unique"
  UNIQUE("tenant_id", "channel", "customer_phone");--> statement-breakpoint

ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "channel" text DEFAULT 'whatsapp' NOT NULL;--> statement-breakpoint

ALTER TABLE "customers"
  DROP CONSTRAINT IF EXISTS "customers_tenant_id_phone_unique";--> statement-breakpoint

ALTER TABLE "customers"
  ADD CONSTRAINT "customers_tenant_id_phone_unique"
  UNIQUE("tenant_id", "channel", "phone");
