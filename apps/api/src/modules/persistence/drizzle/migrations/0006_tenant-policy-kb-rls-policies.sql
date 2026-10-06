-- T5 pattern applied to Feature 2.5's two RLS-scoped tables — same FORCE +
-- NULLIF(..., '')::uuid guard as every prior RLS table (see
-- docs/decisions/F1-security.md for why the NULLIF guard matters).

ALTER TABLE "tenant_policy" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_policy_isolation" ON "tenant_policy"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "kb_documents" FORCE ROW LEVEL SECURITY;

CREATE POLICY "kb_documents_isolation" ON "kb_documents"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
