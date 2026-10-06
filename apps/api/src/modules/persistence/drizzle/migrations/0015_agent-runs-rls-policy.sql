-- T5 pattern applied to Feature 7's agent_runs table (A8) — same FORCE +
-- NULLIF guard as every prior RLS table.

ALTER TABLE "agent_runs" FORCE ROW LEVEL SECURITY;

CREATE POLICY "agent_runs_isolation" ON "agent_runs"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
