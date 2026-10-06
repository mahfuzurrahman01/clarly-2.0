// A1/D3/D4: the pgvector VectorStore implementation. Only file in the
// codebase (besides kb-chunks.table.ts) that speaks pgvector-specific SQL
// (`<=>` cosine-distance operator, `vector` casts) — rule 3 in practice.
//
// search() implements D4's hybrid design: a cosine-similarity pass and a
// tsvector lexical pass, each independently ranked and LIMITed, fused with
// RRF (rrf-fusion.ts) rather than combined by raw score (cosine similarity
// and ts_rank are not on comparable scales). Both passes filter on
// `tenant_id = $1` explicitly — RLS already restricts rows via the GUC,
// but an explicit predicate on the partition key is what lets Postgres's
// planner actually prune to the single relevant partition instead of
// scanning every tenant's partition and relying on RLS to filter after.
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Clock } from '../core/clock/clock';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import { PartitionLifecycleService } from './partition-lifecycle.service';
import { reciprocalRankFusion } from './rrf-fusion';
import {
  VectorStore,
  type VectorStoreChunk,
  type VectorStoreSearchQuery,
  type VectorStoreSearchResponse,
  type VectorStoreSearchResult,
} from './ports/vector-store.port';

/** D4: "rerank top-20 to top-5" — 20 is also the breadth each half of hybrid search fetches before RRF fusion. */
const HYBRID_SEARCH_BREADTH = 20;

interface RawChunkRow {
  [key: string]: unknown;
  id: string;
  content: string;
}

@Injectable()
export class PgVectorStore extends VectorStore {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly partitionLifecycle: PartitionLifecycleService,
    /** P0.3: injected rather than calling Date.now() directly, per the Clock port's own contract ("every call site that needs now injects Clock"). */
    private readonly clock: Clock,
  ) {
    super();
  }

  async upsertChunks(chunks: VectorStoreChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    // Every chunk in a single upsertChunks() call is expected to belong to
    // one tenant/document (RetrievalIngestService's contract) — grouping
    // defensively rather than assuming it, so a caller mixing tenants
    // fails loudly instead of silently mis-partitioning.
    const tenantIds = new Set(chunks.map((chunk) => chunk.tenantId));
    if (tenantIds.size !== 1) {
      throw new Error(
        'PgVectorStore.upsertChunks() requires all chunks to belong to the same tenant',
      );
    }
    const [tenantId] = tenantIds;
    if (!tenantId) return;

    await this.partitionLifecycle.ensurePartitionForTenant(tenantId);

    await this.tenantContext.withTenantTx(async (tx) => {
      for (const chunk of chunks) {
        const kbDocumentId = chunk.metadata?.kbDocumentId;
        const chunkIndex = chunk.metadata?.chunkIndex;
        if (
          typeof kbDocumentId !== 'string' ||
          typeof chunkIndex !== 'number'
        ) {
          throw new Error(
            'PgVectorStore.upsertChunks(): each chunk.metadata must include kbDocumentId (string) and chunkIndex (number)',
          );
        }

        await tx.execute(sql`
          INSERT INTO kb_chunks (id, tenant_id, kb_document_id, chunk_index, content, embedding, embedding_model, embedding_version)
          VALUES (
            ${chunk.id}::uuid,
            ${chunk.tenantId}::uuid,
            ${kbDocumentId}::uuid,
            ${chunkIndex},
            ${chunk.content},
            ${toVectorLiteral(chunk.embedding)}::vector,
            ${chunk.embeddingModel},
            ${chunk.embeddingVersion}
          )
          ON CONFLICT (id, tenant_id) DO UPDATE SET
            content = EXCLUDED.content,
            embedding = EXCLUDED.embedding,
            embedding_model = EXCLUDED.embedding_model,
            embedding_version = EXCLUDED.embedding_version
        `);
      }
    }, tenantId);
  }

  async deleteByDocument(
    tenantId: string,
    kbDocumentId: string,
  ): Promise<number> {
    // tenant_id is in the predicate for the same reason search() carries it:
    // it is the LIST partition key, so naming it lets the planner touch one
    // partition instead of every tenant's. RLS alone would filter, but only
    // after scanning.
    const result = await this.tenantContext.withTenantTx(
      (tx) =>
        tx.execute(sql`
          DELETE FROM kb_chunks
          WHERE tenant_id = ${tenantId}::uuid
            AND kb_document_id = ${kbDocumentId}::uuid
        `),
      tenantId,
    );

    return result.rowCount ?? 0;
  }

  async search(
    query: VectorStoreSearchQuery,
  ): Promise<VectorStoreSearchResponse> {
    const breadth = Math.max(query.topK, HYBRID_SEARCH_BREADTH);

    // P0.3: each phase is timed separately. `searchStartMs` is taken OUTSIDE
    // withTenantTx() on purpose — the difference between it and
    // `vectorStartMs` is the cost of acquiring a pooled connection, opening
    // the transaction and setting the per-tenant GUC, which is real retrieval
    // latency that neither query would otherwise be charged for.
    const searchStartMs = this.clock.nowMs();

    // Applied to BOTH passes, not just the vector one: a document excluded
    // from an agent's scope must not come back through the lexical half
    // either, or scoping would leak exactly on the keyword matches a customer
    // is most likely to trigger.
    // Built as an explicit parameter list rather than `= ANY($1::uuid[])`:
    // drizzle inlines a JS array as one parameter per element, so the array
    // form reaches Postgres as a bare uuid and fails with "malformed array
    // literal". Each id is still a bound parameter, never interpolated.
    const scope =
      query.kbDocumentIds && query.kbDocumentIds.length > 0
        ? sql`AND kb_document_id IN (${sql.join(
            query.kbDocumentIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql``;

    // D5: filter by embedding version so old-version chunks from a re-embed
    // migration don't pollute search results. Applied to both vector and
    // lexical passes for consistency.
    const versionFilter = query.embeddingVersion
      ? sql`AND embedding_version = ${query.embeddingVersion}`
      : sql``;

    return this.tenantContext.withTenantTx(async (tx) => {
      const vectorStartMs = this.clock.nowMs();
      const vectorRows = await tx.execute<RawChunkRow>(sql`
        SELECT id, content
        FROM kb_chunks
        WHERE tenant_id = ${query.tenantId}::uuid
        ${scope}
        ${versionFilter}
        ORDER BY embedding <=> ${toVectorLiteral(query.queryEmbedding)}::vector
        LIMIT ${breadth}
      `);
      const lexicalStartMs = this.clock.nowMs();

      const lexicalRows = await tx.execute<RawChunkRow>(sql`
        SELECT id, content
        FROM kb_chunks
        WHERE tenant_id = ${query.tenantId}::uuid
        ${scope}
        ${versionFilter}
          AND content_tsv @@ plainto_tsquery('english', ${query.queryText})
        ORDER BY ts_rank(content_tsv, plainto_tsquery('english', ${query.queryText})) DESC
        LIMIT ${breadth}
      `);
      const fusionStartMs = this.clock.nowMs();

      const contentById = new Map<string, string>();
      for (const row of [...vectorRows.rows, ...lexicalRows.rows]) {
        contentById.set(row.id, row.content);
      }

      const fused = reciprocalRankFusion([
        vectorRows.rows.map((row) => ({ id: row.id })),
        lexicalRows.rows.map((row) => ({ id: row.id })),
      ]);

      const results: VectorStoreSearchResult[] = fused
        .slice(0, query.topK)
        .map((item) => ({
          chunkId: item.id,
          content: contentById.get(item.id) ?? '',
          score: item.score,
        }));

      const endMs = this.clock.nowMs();
      return {
        results,
        timings: {
          vectorQueryMs: lexicalStartMs - vectorStartMs,
          lexicalQueryMs: fusionStartMs - lexicalStartMs,
          fusionMs: endMs - fusionStartMs,
          totalMs: endMs - searchStartMs,
        },
      };
    }, query.tenantId);
  }
}

function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}
