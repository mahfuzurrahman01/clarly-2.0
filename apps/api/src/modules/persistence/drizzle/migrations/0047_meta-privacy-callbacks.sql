-- Gulf T7 (D7) — Meta Data Deletion Request + Deauthorize callbacks.
--
-- 1. `meta_data_deletion_requests` — one row per deletion request Meta sends
--    on a user's behalf. Platform-level (the request names a Meta user, not
--    a tenant, and arrives with no tenant context), so no tenant_id and no
--    RLS — same reasoning as `social_channels` / `stripe_customer_tenant_map`.
--    The Meta user id is stored only as a SHA-256 hash: it is only matched.
--
-- 2. `social_channels.connected_by_meta_user_hash` — the only link from a
--    callback (which names a user, never a page) back to the channels that
--    user connected. Nullable: rows connected before T4's server-side
--    handshake have no user id recorded, and no backfill is possible without
--    the (possibly already revoked) user token.

CREATE TABLE IF NOT EXISTS "meta_data_deletion_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "confirmation_code" text NOT NULL,
  "meta_user_id_hash" text NOT NULL,
  "signed_request_hash" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "social_channels_scrubbed" integer DEFAULT 0 NOT NULL,
  "error" text,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "meta_data_deletion_requests_confirmation_code_unique" UNIQUE("confirmation_code"),
  CONSTRAINT "meta_data_deletion_requests_signed_request_hash_unique" UNIQUE("signed_request_hash")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "meta_data_deletion_requests_user_idx"
  ON "meta_data_deletion_requests" ("meta_user_id_hash");--> statement-breakpoint

ALTER TABLE "social_channels"
  ADD COLUMN IF NOT EXISTS "connected_by_meta_user_hash" text;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "social_channels_connected_by_meta_user_idx"
  ON "social_channels" ("connected_by_meta_user_hash")
  WHERE "connected_by_meta_user_hash" IS NOT NULL;
