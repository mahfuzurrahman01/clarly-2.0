-- F9 step 1 (docs/decisions/F9-agent-configuration.md): the agent entity and
-- its versioned configuration, plus a BEHAVIOUR-PRESERVING backfill of one
-- published agent per tenant from the existing `tenant_policy` row.
--
-- Nothing reads these tables on the respond path yet. That is the point:
-- this migration runs under live traffic, so it changes storage only, and
-- the routing switch (phone_number_id -> agent) lands as its own change once
-- the data is in place and verifiable.
CREATE TABLE IF NOT EXISTS "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"whatsapp_number_id" uuid,
	"published_version_id" uuid,
	"draft_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_tenant_id_name_unique" UNIQUE("tenant_id","name")
);--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"role_description" text,
	"persona" text,
	"tone" text,
	"languages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"greeting" text,
	"out_of_scope_response" text,
	"forbidden_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"business_hours" jsonb,
	"timezone" text,
	"out_of_hours_response" text,
	"escalation_triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence_threshold" numeric(3, 2) DEFAULT 0.7 NOT NULL,
	"rerank_enabled" boolean DEFAULT true NOT NULL,
	"stuck_ticket_threshold_minutes" integer DEFAULT 15 NOT NULL,
	"handover_auto_return_minutes" integer DEFAULT 60 NOT NULL,
	"max_tool_calls_per_turn" integer DEFAULT 2 NOT NULL,
	"published_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_agent_id_version_unique" UNIQUE("agent_id","version")
);--> statement-breakpoint
ALTER TABLE "agent_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- T5 RLS: same FORCE + NULLIF guard as every prior tenant-scoped table.
-- Constraints and policies above/below are created re-runnably (guarded
-- rather than bare): this migration failed halfway once while being
-- written, and a migration that cannot be re-applied after a partial
-- failure turns an ordinary mistake into hand-repair of a live database.
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "agents_isolation" ON "agents";--> statement-breakpoint
CREATE POLICY "agents_isolation" ON "agents"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

ALTER TABLE "agent_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "agent_versions_isolation" ON "agent_versions";--> statement-breakpoint
CREATE POLICY "agent_versions_isolation" ON "agent_versions"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- Routing lookup (step 2) and the console's per-tenant list.
CREATE INDEX IF NOT EXISTS "agents_tenant_status_idx" ON "agents" ("tenant_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_whatsapp_number_idx" ON "agents" ("whatsapp_number_id")
  WHERE "whatsapp_number_id" IS NOT NULL;--> statement-breakpoint

-- Backfill: one published agent per tenant that already has a policy row.
--
-- Behaviour-preserving by construction. Only the five fields that exist
-- today are copied; every field F9 adds stays at a default that renders
-- NOTHING (null persona/tone/greeting, empty languages/triggers, null
-- business hours), so the prompt this configuration would produce is byte
-- for byte what `tenant_policy` produces now. The two new behaviour knobs
-- default to the platform constants they replace
-- (HANDOVER_AUTO_RETURN_MINUTES=60, MAX_TOOL_ROUND_TRIPS=2).
--
-- Written as a per-tenant loop that sets `app.tenant_id`, NOT as one
-- cross-tenant INSERT...SELECT. `tenant_policy`, `agents` and
-- `agent_versions` are all FORCE ROW LEVEL SECURITY and owned by the same
-- role that runs migrations (`app_user`, which has no BYPASSRLS) — and
-- FORCE means the owner is filtered too. A plain cross-tenant statement
-- therefore reads zero policy rows and inserts nothing, succeeding
-- silently, which is the worst possible outcome for a data migration. The
-- loop makes each iteration look exactly like a normal
-- `withTenantTx()` write. `tenants` and `whatsapp_numbers` carry no RLS, so
-- driving the loop from `tenants` is safe.
--
-- Idempotent: a tenant that already has an agent is skipped, so re-running
-- cannot duplicate.
DO $backfill$
DECLARE
  tenant_row record;
  new_agent_id uuid;
  new_version_id uuid;
  bound_number_id uuid;
BEGIN
  FOR tenant_row IN SELECT id FROM "tenants" LOOP
    PERFORM set_config('app.tenant_id', tenant_row.id::text, true);

    CONTINUE WHEN EXISTS (SELECT 1 FROM "agents" WHERE tenant_id = tenant_row.id);
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM "tenant_policy" WHERE tenant_id = tenant_row.id
    );

    -- Bound only when the tenant has exactly one number. Two numbers is a
    -- real routing decision (which agent answers which), and guessing it
    -- here would silently pick one for them.
    SELECT w.id INTO bound_number_id
    FROM "whatsapp_numbers" w
    WHERE w.tenant_id = tenant_row.id
      AND (SELECT count(*) FROM "whatsapp_numbers" w2
            WHERE w2.tenant_id = tenant_row.id) = 1
    LIMIT 1;

    INSERT INTO "agents" ("tenant_id", "name", "status", "whatsapp_number_id")
    VALUES (tenant_row.id, 'Default agent', 'published', bound_number_id)
    RETURNING id INTO new_agent_id;

    INSERT INTO "agent_versions" (
      "tenant_id", "agent_id", "version", "persona", "forbidden_topics",
      "confidence_threshold", "rerank_enabled", "stuck_ticket_threshold_minutes",
      "published_at"
    )
    SELECT
      tenant_row.id,
      new_agent_id,
      1,
      p.tone_persona_override,
      p.forbidden_topics,
      p.confidence_threshold,
      p.rerank_enabled,
      p.stuck_ticket_threshold_minutes,
      now()
    FROM "tenant_policy" p
    WHERE p.tenant_id = tenant_row.id
    RETURNING id INTO new_version_id;

    UPDATE "agents"
    SET "published_version_id" = new_version_id
    WHERE id = new_agent_id;
  END LOOP;
END
$backfill$;
