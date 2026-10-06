-- Feature 3/A1 (D3): kb_chunks — LIST partitioned by tenant_id, one HNSW
-- index per partition (achieved by creating the HNSW index ONCE on the
-- parent; PG 11+ treats that as a "partitioned index" and automatically
-- creates matching child indexes on every existing AND future partition —
-- no per-partition manual index management needed). RLS FORCE on the
-- parent, same NULLIF guard as every other RLS table in this repo.
--
-- The `vector` extension itself is NOT created here — it's an infra/
-- bootstrap concern (docker/postgres-init/01-app-role.sql for local dev,
-- the CI workflow's bootstrap step for CI), run as a superuser BEFORE
-- app_user's migrations, exactly like app_user's own role creation.
-- app_user (who runs this migration) does not have CREATE EXTENSION
-- privilege, and doesn't need it — Supabase's prod Postgres already ships
-- pgvector regardless (D3).
--
-- This table's TypeScript definition does NOT live in schema.ts's barrel
-- (drizzle-kit's auto-diff target) — it lives in RetrievalModule
-- (kb-chunks.table.ts), used only for query-building, never for
-- drizzle-kit generate. PARTITION BY / HNSW / generated columns are past
-- what drizzle-kit's declarative table builder round-trips cleanly, so
-- this table is hand-authored SQL going forward, not auto-generated diffs.

CREATE TABLE "kb_chunks" (
	"id" uuid NOT NULL DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"kb_document_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding_version" text NOT NULL,
	"content_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
	"created_at" timestamp with time zone NOT NULL DEFAULT now(),
	PRIMARY KEY ("id", "tenant_id"),
	CONSTRAINT "kb_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE,
	CONSTRAINT "kb_chunks_kb_document_id_kb_documents_id_fk" FOREIGN KEY ("kb_document_id") REFERENCES "public"."kb_documents"("id") ON DELETE CASCADE
) PARTITION BY LIST ("tenant_id");
--> statement-breakpoint

ALTER TABLE "kb_chunks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "kb_chunks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY "kb_chunks_isolation" ON "kb_chunks"
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint

-- D4: cosine-similarity half of hybrid search.
CREATE INDEX "kb_chunks_embedding_hnsw_idx" ON "kb_chunks" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint

-- D4: lexical half of hybrid search (Postgres tsvector).
CREATE INDEX "kb_chunks_content_tsv_gin_idx" ON "kb_chunks" USING gin ("content_tsv");
--> statement-breakpoint

-- Safety-net default partition: Postgres requires every row to match a
-- LIST partition or fall to a DEFAULT partition, or the insert fails
-- outright. The real insert path (PgVectorStore.upsertChunks()) always
-- calls ensurePartitionForTenant() first, so rows should never actually
-- land here — this exists as a guard against a race/bug in that lifecycle
-- rather than as the primary insert path.
CREATE TABLE "kb_chunks_default" PARTITION OF "kb_chunks" DEFAULT;
