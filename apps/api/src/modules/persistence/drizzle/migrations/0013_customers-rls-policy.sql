-- T5 pattern applied to Feature 5's new `customers` table — same FORCE +
-- NULLIF guard as every prior RLS table.

ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;

CREATE POLICY "customers_isolation" ON "customers"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
