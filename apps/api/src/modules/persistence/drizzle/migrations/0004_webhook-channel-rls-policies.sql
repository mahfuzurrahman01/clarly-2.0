-- T5 pattern applied to Feature 2's two RLS-scoped tables — same FORCE +
-- NULLIF(..., '')::uuid guard as tenant_tools (0002), for the identical
-- reason documented there and in docs/decisions/F1-security.md: a bare
-- ::uuid cast on a recycled pooled connection's reverted-to-'' GUC throws
-- instead of failing closed.
--
-- whatsapp_numbers is deliberately NOT RLS-scoped here — see its table
-- comment: the tenant-resolution read (phone_number_id -> tenant_id) must
-- run BEFORE any tenant context exists, so it goes through
-- PersistenceService.runAdminQuery(), not withTenantTx(); RLS would make
-- that lookup impossible by definition. Same category as `tenants` itself.

ALTER TABLE "webhook_message_dedup" FORCE ROW LEVEL SECURITY;

CREATE POLICY "webhook_message_dedup_isolation" ON "webhook_message_dedup"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE "tickets" FORCE ROW LEVEL SECURITY;

CREATE POLICY "tickets_isolation" ON "tickets"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
