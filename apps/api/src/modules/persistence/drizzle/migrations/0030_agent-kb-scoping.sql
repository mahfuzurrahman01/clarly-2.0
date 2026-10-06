-- F9: per-agent knowledge-base scoping.
--
-- Deliberately additive and inert on arrival: no rows means every agent keeps
-- retrieving across the tenant's whole knowledge base, exactly as before. A
-- migration that silently narrowed what a live agent can answer from would
-- turn answered questions into escalations overnight.
CREATE TABLE IF NOT EXISTS "agent_kb_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kb_document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_kb_documents_agent_id_kb_document_id_unique" UNIQUE("agent_id","kb_document_id")
);--> statement-breakpoint
ALTER TABLE "agent_kb_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "agent_kb_documents" ADD CONSTRAINT "agent_kb_documents_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_kb_documents" ADD CONSTRAINT "agent_kb_documents_agent_id_agents_id_fk"
    FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_kb_documents" ADD CONSTRAINT "agent_kb_documents_kb_document_id_kb_documents_id_fk"
    FOREIGN KEY ("kb_document_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

ALTER TABLE "agent_kb_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "agent_kb_documents_isolation" ON "agent_kb_documents";--> statement-breakpoint
CREATE POLICY "agent_kb_documents_isolation" ON "agent_kb_documents"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint

-- Read on every turn for a scoped agent: "which documents may this agent use".
CREATE INDEX IF NOT EXISTS "agent_kb_documents_agent_idx"
  ON "agent_kb_documents" ("agent_id");
