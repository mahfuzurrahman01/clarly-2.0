-- T5 hardening: Postgres does not inherit RLS from a partitioned parent to
-- its partitions. `kb_chunks` (the parent) is RLS-enabled + FORCED with
-- `kb_chunks_isolation`, which covers every query routed through the parent —
-- but a query naming a partition directly (`kb_chunks_<tenant_uuid>`) applies
-- that partition's OWN policies, and partitions were created with none. This
-- backfills every existing partition with the parent's policy so direct-
-- partition access is isolated too.
--
-- New partitions get the same treatment at creation time in
-- PartitionLifecycleService.ensurePartitionForTenant(); this migration only
-- closes the gap for partitions that already exist.

DO $$
DECLARE
  part record;
BEGIN
  FOR part IN
    SELECT c.relname AS name
    FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE n.nspname = 'public'
      AND parent.relname = 'kb_chunks'
      AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part.name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part.name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', part.name || '_isolation', part.name);
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL '
      'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
      'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      part.name || '_isolation', part.name
    );
  END LOOP;
END
$$;
