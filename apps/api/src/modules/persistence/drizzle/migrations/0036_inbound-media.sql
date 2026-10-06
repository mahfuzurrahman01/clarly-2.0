-- F13: inbound media a human can actually see.
--
-- Two defects close here, and the second is the larger one:
--
--   1. Images, voice notes and documents escalated correctly (T3) but their
--      bytes were never fetched, so the person handling the ticket worked
--      blind on exactly the messages that most needed a human.
--   2. A non-text message never produced a `messages` row at all. The
--      transcript did not say "the customer sent a photo" — it said nothing,
--      and the message was missing from the history entirely.
--
-- Columns on `messages` rather than a side table: WhatsApp carries at most
-- one attachment per message, so a 1:1 join would buy nothing and cost every
-- transcript read an extra one.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "media_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "media_status" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "media_storage_key" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "media_mime_type" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "media_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "media_filename" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "media_error" text;--> statement-breakpoint

-- The retention purge (T16) has to find rows whose bytes still need deleting
-- from object storage before the row itself goes; without this it would be a
-- sequential scan of every message ever sent.
CREATE INDEX IF NOT EXISTS "messages_media_storage_key_idx"
  ON "messages" ("media_storage_key")
  WHERE "media_storage_key" IS NOT NULL;
