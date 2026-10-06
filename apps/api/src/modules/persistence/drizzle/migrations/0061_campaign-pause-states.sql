-- F19 (D3/D8) send-path slice: two more terminal-able pause states for
-- `campaigns.status`.
--
-- Migration 0055 shipped the enum the spec enumerates, which covers only the
-- two AUTOMATIC pauses (spend cap, template). The send path needs two more,
-- and both are pauses in exactly the same sense — the campaign stops with
-- every remaining recipient left `pending`, and `POST /campaigns/:id/resume`
-- re-runs the full gate before it starts again:
--
--   paused_manual      — D8's `POST /campaigns/:id/pause`: a merchant stopped
--                        it. Without this, an operator pause would have to
--                        borrow one of the automatic reasons and the console
--                        could not tell "I paused this" from "Meta paused
--                        this", which are different problems with different
--                        fixes.
--   paused_eligibility — a REVOCABLE D4 block (messaging health, quality,
--                        business verification, billing) appeared mid-send.
--                        D4 re-checks that subset once per batch precisely
--                        because Meta can revoke it at any time; the result
--                        has to be a distinct state, since the fix is on
--                        Meta's side, not in the template and not in the cap.
--
-- Widening a CHECK is additive: every existing row still satisfies it, and
-- no code that does not use the new values is affected.
ALTER TABLE "campaigns" DROP CONSTRAINT IF EXISTS "campaigns_status_check";--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_status_check" CHECK ("status" IN
  ('draft', 'scheduled', 'sending', 'paused_spend_cap', 'paused_template',
   'paused_manual', 'paused_eligibility',
   'completed', 'canceled', 'failed'));--> statement-breakpoint

-- The send path's hot read: "the next N `pending` recipients of this
-- campaign, in a stable order". 0055's `campaign_recipients_campaign_status_idx`
-- (campaign_id, status) already answers it, but every batch also ORDERs BY id
-- to keep the keyset stable across a retry, so the id goes in the index and
-- the sort disappears from the plan.
CREATE INDEX IF NOT EXISTS "campaign_recipients_campaign_status_id_idx"
  ON "campaign_recipients" ("campaign_id", "status", "id");
