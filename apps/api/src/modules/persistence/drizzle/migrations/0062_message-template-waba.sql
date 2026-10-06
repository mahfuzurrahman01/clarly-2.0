-- F19 (D2, bullet 5): make the template<->WABA eligibility check enforceable.
--
-- D2 specified, as the fifth authoring check, that "the template's WABA
-- matches the sending number's waba_id — template approval is per-WABA, so a
-- template approved on WABA A cannot send from a number on WABA B". That
-- check was unenforceable as written: `message_templates` carried no WABA at
-- all, so there was nothing to compare `whatsapp_numbers.waba_id` against.
-- This migration adds the missing side of the comparison (defect in the
-- decision doc's premise, corrected 2026-09-22 — see the doc's D2).
--
-- NULLABLE, not NOT NULL. Every row that predates this migration was synced
-- without recording which account reported it, and there is no honest value
-- to backfill for a tenant with two WABAs. Rather than invent one, the
-- eligibility gate treats null as a BLOCK (fail-closed, the house rule for
-- this gate): re-syncing templates populates the column and clears the block.
ALTER TABLE "message_templates" ADD COLUMN IF NOT EXISTS "waba_id" text;--> statement-breakpoint

-- Backfill only where the answer is unambiguous: the tenant has exactly ONE
-- connected number carrying a WABA id, so every WhatsApp template of theirs
-- can only have been approved on that account. A tenant with two WABAs (or
-- none recorded) is left null on purpose — the fail-closed check turns that
-- into an actionable "re-sync your templates", not a wrong send.
UPDATE "message_templates" AS t
   SET "waba_id" = sole."waba_id"
  FROM (
    SELECT "tenant_id", MIN("waba_id") AS "waba_id"
      FROM "whatsapp_numbers"
     WHERE "waba_id" IS NOT NULL
     GROUP BY "tenant_id"
    HAVING COUNT(DISTINCT "waba_id") = 1
  ) AS sole
 WHERE t."tenant_id" = sole."tenant_id"
   AND t."kind" = 'whatsapp_template'
   AND t."waba_id" IS NULL;--> statement-breakpoint

-- The gate's read is by (tenant_id, id) via the existing unique key, so no
-- new index is needed for the check itself. This one serves the sync's
-- "which of this tenant's templates belong to WABA X" pass.
CREATE INDEX IF NOT EXISTS "message_templates_tenant_waba_idx"
  ON "message_templates" ("tenant_id", "waba_id");
