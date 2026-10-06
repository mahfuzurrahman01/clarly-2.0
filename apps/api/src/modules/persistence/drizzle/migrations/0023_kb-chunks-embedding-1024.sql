-- Feature 3/A0/D5: retype kb_chunks.embedding from vector(1536) to
-- vector(1024) for the Gemini -> Qwen3-Embedding (vLLM) embedder swap.
--
-- On the dimension, and why it is not 2560:
--
--   The endpoint served Qwen3-Embedding-4B (2560 dims) when this work
--   started and Qwen3-Embedding-0.6B (1024 dims) an hour later — it is not
--   our box and its model is not pinned. 1024 is what it serves now; the
--   adapter's width check (qwen-embedder.adapter.ts) turns any future swap
--   into a loud startup/ingest failure rather than a silently corrupted
--   index. ALWAYS check GET <EMBEDDING_BASE_URL>/v1/models before changing
--   this.
--
--   Anything WIDER THAN 2000 cannot use a plain `vector` HNSW index at all.
--   Verified against this project's own pgvector 0.8.0:
--
--     CREATE TABLE p(v vector(2560));
--     CREATE INDEX ON p USING hnsw (v vector_cosine_ops);
--     ERROR:  column cannot have more than 2000 dimensions for hnsw index
--
--   `halfvec` raises that ceiling to 4000, so a return to the 4B model means
--   `halfvec(2560)` plus `halfvec_cosine_ops`, not merely a bigger number.
--   Without that the ANN index silently disappears and every search degrades
--   to a sequential scan — a regression that passes tests and only shows up
--   as latency in production. At 1024 we are under the cap, so plain
--   `vector` is correct and keeps full float32 precision.
--
-- Why content is preserved but embeddings are not:
--
--   There is no meaningful conversion from a 1536-dim Gemini vector to a
--   1024-dim Qwen one — different width AND a different, non-comparable
--   vector space — so every embedding must be recomputed regardless.
--   `content` is a different matter: kb_documents stores only a
--   `storage_key`, not the extracted text, so re-deriving chunk content
--   means re-downloading and re-chunking every source document. Keeping the
--   rows makes the follow-up a pure re-embed (scripts/reembed-chunks.ts)
--   that needs nothing but the embedder.
--
--   Rows are therefore retyped in place with a zero placeholder vector and
--   flagged `embedding_version = 'pending-reembed'`. A zero vector yields
--   NaN cosine distance, and Postgres sorts NaN last in an ASC ordering, so
--   un-re-embedded chunks fall to the bottom of `ORDER BY embedding <=> q`
--   rather than surfacing as spurious top hits. Retrieval quality degrades
--   to "these chunks are invisible" instead of "these chunks are wrong".
--
-- OPERATIONALLY THIS MIGRATION IS HALF A CHANGE. Every chunk is unretrievable
-- until `pnpm --filter api reembed` finishes. Run the two together.
--
-- Ordering matters: the HNSW index must be dropped BEFORE the type change.
-- Postgres will not rewrite a column out from under an index whose opclass
-- no longer applies to it.

-- Dropping the parent's partitioned index cascades to every child
-- partition's matching index (PG 11+ manages those automatically), so there
-- is no per-tenant index cleanup to do here.
DROP INDEX IF EXISTS "kb_chunks_embedding_hnsw_idx";
--> statement-breakpoint

-- Both columns are retyped in ONE statement, and the sentinel is applied as
-- part of that DDL rewrite rather than by a following UPDATE. That is not a
-- style choice — kb_chunks has FORCE ROW LEVEL SECURITY, and migrations run
-- with no `app.tenant_id` GUC set, so the policy's
-- `tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`
-- evaluates NULL and a plain UPDATE silently matches ZERO rows. Observed
-- exactly that against the real database: the retype landed, the UPDATE did
-- nothing, and every chunk was left holding a zero vector while still
-- labelled 'g1' — a dead KB that the re-embed script would skip as
-- "nothing to do". DDL is not subject to RLS, so folding the stamp into the
-- ALTER is what makes the two halves atomic and honest.
--
-- `embedding_version TYPE text USING '...'` is a no-op type change used for
-- its USING clause; that is the only way to rewrite a column value from DDL.
ALTER TABLE "kb_chunks"
  ALTER COLUMN "embedding" TYPE vector(1024)
    USING array_fill(0::real, ARRAY[1024])::vector(1024),
  ALTER COLUMN "embedding_version" TYPE text
    USING 'pending-reembed';
--> statement-breakpoint

-- Recreated on the parent so PG 11+ propagates it to every existing and
-- future partition, same as migration 0008 did.
CREATE INDEX "kb_chunks_embedding_hnsw_idx"
  ON "kb_chunks" USING hnsw ("embedding" vector_cosine_ops);
