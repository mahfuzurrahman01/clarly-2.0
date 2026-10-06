import { MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { TenantAuthMiddleware } from '../auth/tenant-auth.middleware';
import { BillingModule } from '../billing/billing.module';
import { CoreModule } from '../core';
import { QueueModule } from '../queue/queue.module';
import { RetrievalModule } from '../retrieval/retrieval.module';
import { TenantContextModule } from '../tenant-context/tenant-context.module';
import { KbDocumentController } from './kb-document.controller';
import { KbDocumentService } from './kb-document.service';
import { KbIngestProcessor } from './kb-ingest.processor';
import { KB_INGEST_QUEUE } from './kb-ingest.queue';
import { StorageModule } from '../storage/storage.module';

export * from '../storage/ports/object-storage.port';
export * from './kb-ingest-job.dto';
export * from './kb-document.dto';

// Agent (AI-owned): KB CRUD, ingest jobs, index lifecycle, KBNotIndexed
// (A1). No dependency-rule constraints apply directly, but must not import
// pgvector types itself (rule 3) — D3's kb_chunks/pgvector work is
// Feature 3's A1 pipeline, not this module.
//
// THIS PASS (Feature 2.5 + Feature 3/A1 + Feature 6's HTTP wrapper):
// upload -> store (ObjectStorage port, bound to LocalFilesystemStorageAdapter
// — see docs/decisions/F2.5-kb-foundation.md for why a real Supabase
// Storage adapter isn't wired instead) -> register kb_documents row ->
// enqueue `kb-ingest`. KbIngestProcessor calls RetrievalModule's real A1
// pipeline (chunk -> embed -> pgvector upsert). `KbDocumentController`
// (Feature 6) is the real HTTP surface over the same
// `KbDocumentService.upload()`/`listForTenant()` that already existed —
// no new mechanism, per that service's own header comment.
@Module({
  imports: [
    CoreModule,
    AuthModule,
    BillingModule,
    TenantContextModule,
    QueueModule,
    RetrievalModule,
    StorageModule,
    BullModule.registerQueue({
      name: KB_INGEST_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    }),
  ],
  controllers: [KbDocumentController],
  providers: [KbDocumentService, KbIngestProcessor],
  // StorageModule rather than the ObjectStorage token itself: Nest can only
  // export a provider this module declares, and since F13 the port is
  // declared by StorageModule. Re-exporting the module keeps the
  // backward-compatible path open for anything still reaching ObjectStorage
  // through KnowledgeBaseModule, which exporting the bare token does not —
  // it throws UnknownExportException at bootstrap.
  exports: [StorageModule, KbDocumentService],
})
export class KnowledgeBaseModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantAuthMiddleware).forRoutes(KbDocumentController);
  }
}
