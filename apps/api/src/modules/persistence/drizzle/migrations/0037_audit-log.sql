-- The audit log: who did what, for a security review and for the tenant's own
-- "who deleted that?" question.
--
-- Three properties this table has that no other table here does:
--
--   1. APPEND-ONLY, enforced by the ABSENCE of policies rather than by
--      convention. Under FORCE ROW LEVEL SECURITY, policies apply to the table
--      owner too, and a command with no permissive policy matches zero rows.
--      So granting only SELECT and INSERT policies makes UPDATE and DELETE
--      no-ops for everyone, including the role that owns the table. A log the
--      application can rewrite is not evidence.
--
--      Note this is deliberately NOT done with REVOKE. `app_user` owns this
--      table, and an owner's implicit privileges are not governed by GRANT or
--      REVOKE — revoking would have looked like a guarantee and been none.
--
--      Tenant offboarding still works: PostgreSQL performs foreign-key cascade
--      deletes outside RLS, so the ON DELETE CASCADE from `tenants` still
--      clears a departing tenant's history.
--   2. EXEMPT from T16's 90-day transcript purge. Nothing here references
--      conversations or messages, so no cascade path exists. Deliberate: a log
--      that ages out cannot answer a question about last year.
--   3. No expiry of its own. There is no retention job for this table and one
--      should not be added without an explicit decision.

CREATE TABLE "audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "actor_user_id" text NOT NULL,
  "actor_role" text,
  "method" text NOT NULL,
  "route" text NOT NULL,
  "target_id" text,
  "status_code" integer NOT NULL,
  "outcome" text NOT NULL,
  "detail" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "audit_log"
  ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- The only read pattern: one tenant's history, newest first.
CREATE INDEX "audit_log_tenant_created_idx"
  ON "audit_log" ("tenant_id", "created_at" DESC);--> statement-breakpoint

-- T5 pattern — same FORCE + NULLIF guard as every prior RLS table.
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Same NULLIF guard as every prior RLS table, but split by command instead of
-- FOR ALL. The split IS the append-only enforcement: there is no UPDATE policy
-- and no DELETE policy, so under FORCE RLS those commands affect no rows.
CREATE POLICY "audit_log_read" ON "audit_log"
  AS PERMISSIVE
  FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

CREATE POLICY "audit_log_append" ON "audit_log"
  AS PERMISSIVE
  FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
