-- T5 pattern applied to Feature 4's two new tables — same FORCE + NULLIF
-- guard as every prior RLS table.

ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "conversations_isolation" ON "conversations"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;

CREATE POLICY "messages_isolation" ON "messages"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
