-- T5: tenant isolation policy for tenant_tools, plus FORCE ROW LEVEL
-- SECURITY. FORCE matters because Postgres RLS is a no-op for the table
-- owner unless FORCE is also set (and a no-op regardless of FORCE for
-- superusers / roles with BYPASSRLS — see docs/decisions/F1-security.md for
-- why the connecting role's privileges are as load-bearing as this SQL).
--
-- Policy: a row is visible/writable only when the transaction-scoped GUC
-- app.tenant_id (set by TenantContextService.withTenantTx()) equals the
-- row's tenant_id. current_setting(..., true) returns NULL on a virgin
-- connection that has NEVER touched this custom GUC, but — verified
-- empirically, not assumed — once a connection has set it at least once
-- (which every connection in our pg.Pool will, since Pool connections are
-- reused across requests), Postgres reverts a LOCAL-scoped custom GUC to an
-- EMPTY STRING after commit, not NULL. `current_setting(..., true)::uuid`
-- on '' throws `invalid input syntax for type uuid`, not "zero rows" —
-- NULLIF(..., '') normalizes both the empty-string and true-NULL cases to
-- NULL before the cast, so a missing GUC fails closed (zero rows) on every
-- connection, not just a connection's first-ever transaction.
ALTER TABLE "tenant_tools" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tenant_tools_isolation" ON "tenant_tools"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
