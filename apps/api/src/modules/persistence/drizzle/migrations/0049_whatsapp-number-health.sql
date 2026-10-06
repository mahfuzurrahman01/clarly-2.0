-- Gulf T5 (D5) — WhatsApp number health.
--
-- `connection_state` / `connection_error` already exist (0048, T3). This adds
-- what feeds and explains them:
--
--   - `waba_id`, `display_phone_number`: WABA webhooks (`account_update`,
--     `phone_number_quality_update`, `phone_number_name_update`) name the
--     WABA and the display number, never the phone_number_id. Both were only
--     inside the encrypted credentials blob until now, which a webhook lookup
--     cannot search. Nullable: rows connected before T5 are backfilled by the
--     daily reconcile (it decrypts the blob; SQL cannot).
--   - `verified_name`, `quality_rating`, `messaging_limit_tier`,
--     `name_status`, `messaging_health`, `health_issues`: Meta's own values,
--     verbatim. No
--     CHECK constraints: Meta adds values without notice, and a CHECK would
--     turn a new value into a failed webhook.
--   - `payment_method_attached`: WABA `primary_funding_id` is set (null =
--     not read yet).
--   - `last_health_check_at`: the last successful reconcile read.
--   - `connected_by_meta_user_hash`: SHA-256 of the Meta user behind the
--     Embedded Signup token, so the deauthorize callback (T7) can find the
--     numbers that login connected. Same scheme as social_channels (0047).

ALTER TABLE "whatsapp_numbers" ADD COLUMN IF NOT EXISTS "waba_id" text;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN IF NOT EXISTS "display_phone_number" text;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN IF NOT EXISTS "verified_name" text;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN IF NOT EXISTS "payment_method_attached" boolean;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN IF NOT EXISTS "quality_rating" text;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN IF NOT EXISTS "messaging_limit_tier" text;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN IF NOT EXISTS "name_status" text;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN IF NOT EXISTS "messaging_health" text;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN IF NOT EXISTS "health_issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN IF NOT EXISTS "last_health_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "whatsapp_numbers" ADD COLUMN IF NOT EXISTS "connected_by_meta_user_hash" text;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "whatsapp_numbers_waba_id_idx"
  ON "whatsapp_numbers" ("waba_id")
  WHERE "waba_id" IS NOT NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "whatsapp_numbers_connected_by_meta_user_idx"
  ON "whatsapp_numbers" ("connected_by_meta_user_hash")
  WHERE "connected_by_meta_user_hash" IS NOT NULL;
