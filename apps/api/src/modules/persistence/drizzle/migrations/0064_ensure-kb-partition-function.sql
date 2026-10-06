-- Partition lifecycle DDL must run as a role that owns `kb_chunks`, but the
-- API connects as `app_user`, which only has DML on it (owner: `postgres` on
-- the hosted Supabase project). `CREATE TABLE ... PARTITION OF` needs
-- ownership of the parent and `DROP TABLE` needs ownership of the partition,
-- so PartitionLifecycleService's raw DDL failed as `app_user` with 42501
-- "must be owner of table kb_chunks" — every new tenant's first KB upload
-- failed (found by the L2 commerce eval, 2026-09-28).
--
-- SECURITY DEFINER functions created by kb_chunks' owner move the ownership
-- requirement onto the functions, so `app_user` only needs EXECUTE. The
-- tenant id arrives as a uuid (the type is the input validation) and the
-- identifier is built with format(%I), so there is no injection surface.
--
-- RLS: Postgres does not inherit RLS from a partitioned parent to its
-- partitions (see 0022), so each new partition gets its own copy of the
-- parent's isolation policy — same predicate as kb_chunks_isolation, FORCE
-- included so the table owner is subject to it too.
--
-- The guard refuses to install the functions under an owner that could not
-- run the DDL; otherwise a run as the wrong role would succeed here and fail
-- later, inside a request, with a far less obvious error.

DO $$
DECLARE
  owner_name text := (
    SELECT pg_get_userbyid(c.relowner)
    FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'kb_chunks'
  );
  is_super boolean := (
    SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user
  );
BEGIN
  IF NOT is_super AND owner_name IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION
      'partition lifecycle functions must be created by the owner of public.kb_chunks or a superuser (owner: %, current role: %)',
      owner_name, current_user;
  END IF;
END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.ensure_kb_partition(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  part text := 'kb_chunks_' || replace(p_tenant_id::text, '-', '_');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF public.kb_chunks FOR VALUES IN (%L)',
    part,
    p_tenant_id
  );
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I', part || '_isolation', part);
  EXECUTE format(
    'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL '
    'USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) '
    'WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
    part || '_isolation',
    part
  );
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.ensure_kb_partition(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.ensure_kb_partition(uuid) TO app_user;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.drop_kb_partition(p_tenant_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- IF EXISTS: a tenant that never uploaded a document never had a
  -- partition, and offboarding must not fail on the tidiest account.
  EXECUTE format(
    'DROP TABLE IF EXISTS %I',
    'kb_chunks_' || replace(p_tenant_id::text, '-', '_')
  );
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.drop_kb_partition(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.drop_kb_partition(uuid) TO app_user;
--> statement-breakpoint
-- Supabase's default privileges grant EXECUTE on every new public function to
-- anon/authenticated/service_role directly, which REVOKE ... FROM PUBLIC does
-- not touch. Left in place, anyone holding the public anon key could call
-- rpc/drop_kb_partition through PostgREST and drop any tenant's knowledge
-- base. Guarded by role existence so a plain Postgres (local, CI) is a no-op.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.ensure_kb_partition(uuid) FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.drop_kb_partition(uuid) FROM %I', r);
    END IF;
  END LOOP;
END
$$;
