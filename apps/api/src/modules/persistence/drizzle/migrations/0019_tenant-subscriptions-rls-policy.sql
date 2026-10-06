-- T5 pattern applied to Feature 8's tenant_subscriptions table (T19) —
-- same FORCE + NULLIF guard as every prior RLS table. `plans` is
-- deliberately NOT RLS-scoped (platform catalog, same reasoning as
-- `tenants` itself).

ALTER TABLE "tenant_subscriptions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_subscriptions_isolation" ON "tenant_subscriptions"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
