-- Gulf T3 (D3, D5) — WhatsApp Embedded Signup.
--
-- `whatsapp_numbers.connection_state`: a number whose `/register` call
-- failed after `/subscribed_apps` succeeded is stored, but must never look
-- `active` (docs/GULF_PARITY_PLAN.md F21). The value set is D5's shared enum
-- in full, so T5 (health columns; webhook, send-path and reconcile writers)
-- adds writers, not a second migration of this column.
--
-- Every existing row was connected and working under the old model, so the
-- default 'active' is the true state for them: no backfill guess.

ALTER TABLE "whatsapp_numbers"
  ADD COLUMN IF NOT EXISTS "connection_state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint

ALTER TABLE "whatsapp_numbers"
  ADD COLUMN IF NOT EXISTS "connection_error" text;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "whatsapp_numbers"
    ADD CONSTRAINT "whatsapp_numbers_connection_state_check"
    CHECK ("connection_state" IN ('active', 'reconnect_required', 'restricted', 'disconnected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
