-- ISSUE-001: while a conversation is in human handover the agent stays silent,
-- but the customer gets at most ONE short holding reply per handover. This
-- records when it was sent; startHandover/returnToAgent clear it so the next
-- handover gets its own. Nullable, no backfill: existing rows have sent none.
ALTER TABLE "conversations" ADD COLUMN "handover_holding_reply_at" timestamp with time zone;
