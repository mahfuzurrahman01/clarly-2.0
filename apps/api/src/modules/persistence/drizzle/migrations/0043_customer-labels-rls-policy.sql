-- T5 pattern applied to Feature 18's new `customer_labels` table — same FORCE +
-- NULLIF guard as every prior RLS table (see 0013 for `customers`).
--
-- FORCE matters here specifically: the app connects as a table owner in some
-- environments, and a plain ENABLE is silently skipped for the owner. Feature
-- 18's exit criterion is an ADVERSARIAL cross-tenant read/write test, which
-- would pass vacuously without this line.
--
-- The NULLIF guard makes a missing `app.tenant_id` GUC compare as NULL rather
-- than raising on the ''::uuid cast, so a connection with no tenant context
-- fails closed to zero rows instead of erroring — same behavior documented in
-- 0002.

-- ENABLE and FORCE are two different switches and BOTH are required. ENABLE
-- turns the policy on for ordinary roles; FORCE additionally applies it to the
-- table's owner, which is what the app connects as in some environments.
-- Without ENABLE, FORCE alone is inert and every adversarial query below
-- succeeds.
ALTER TABLE "customer_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

ALTER TABLE "customer_labels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "customer_labels_isolation" ON "customer_labels"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
