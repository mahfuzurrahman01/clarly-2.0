-- T5 pattern applied to Feature 7's conversation_outcomes table (A9) —
-- same FORCE + NULLIF guard as every prior RLS table.

ALTER TABLE "conversation_outcomes" FORCE ROW LEVEL SECURITY;

CREATE POLICY "conversation_outcomes_isolation" ON "conversation_outcomes"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
