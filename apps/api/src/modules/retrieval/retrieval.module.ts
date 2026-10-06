import { Module } from '@nestjs/common';
import { AppConfigService, CoreModule } from '../core';
import { LlmModule } from '../llm/llm.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { CohereRerankerAdapter } from './cohere-reranker.adapter';
import { NoopRerankerAdapter } from './noop-reranker.adapter';
import { PartitionLifecycleService } from './partition-lifecycle.service';
import { PgVectorStore } from './pg-vector-store';
import { Reranker } from './ports/reranker.port';
import { VectorStore } from './ports/vector-store.port';
import { RetrievalIngestService } from './retrieval-ingest.service';
import { RetrievalSearchService } from './retrieval-search.service';

export * from './ports/vector-store.port';
export * from './ports/reranker.port';
export * from './retrieval-search.service';
export * from './retrieval-timings';
export { RetrievalIngestService } from './retrieval-ingest.service';
export type {
  IngestDocumentInput,
  IngestDocumentResult,
} from './retrieval-ingest.service';

// Agent (AI-owned): chunking, embedding, hybrid search, rerank, VectorStore port (A1). Enforced rule 3: nothing outside RetrievalModule may import pgvector types.
//
// THIS PASS (A1-proper): `PgVectorStore` (the only file besides
// kb-chunks.table.ts that speaks pgvector-specific SQL — rule 3 in
// practice, not just in the port shape), `PartitionLifecycleService` (D3's
// per-tenant partition lifecycle), `RetrievalIngestService`/
// `RetrievalSearchService` (chunking+embed / hybrid-search+rerank).
// `Reranker` binds to `CohereRerankerAdapter` when `RERANK_PROVIDER=cohere`,
// else `NoopRerankerAdapter` (this environment's default — no Cohere
// account provisioned, see docs/decisions/F3-agent-core.md) — the single
// swap point, same pattern as LlmModule's `LLM_PROVIDER`.
@Module({
  imports: [CoreModule, TenantContextModule, LlmModule],
  controllers: [],
  providers: [
    PartitionLifecycleService,
    { provide: VectorStore, useClass: PgVectorStore },
    {
      provide: Reranker,
      useFactory: (
        config: AppConfigService,
        cohere: CohereRerankerAdapter,
        noop: NoopRerankerAdapter,
      ) => (config.rerankProvider === 'cohere' ? cohere : noop),
      inject: [AppConfigService, CohereRerankerAdapter, NoopRerankerAdapter],
    },
    CohereRerankerAdapter,
    NoopRerankerAdapter,
    RetrievalIngestService,
    RetrievalSearchService,
  ],
  exports: [
    VectorStore,
    Reranker,
    RetrievalIngestService,
    RetrievalSearchService,
    // Tenant offboarding drops the partition: kb_chunks is a partitioned
    // table, not a child of `tenants`, so nothing else reaches it.
    PartitionLifecycleService,
  ],
})
export class RetrievalModule {}
