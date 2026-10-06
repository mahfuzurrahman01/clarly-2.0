-- Feature 17 follow-up (voice-note player transcript display, 2026-09-21):
-- persist the ASR transcript the agent turn already computes in-memory
-- (media-understanding.service.ts) so the inbox can show it instead of
-- discarding it once the turn finishes.
ALTER TABLE "messages" ADD COLUMN "media_transcript" text;
