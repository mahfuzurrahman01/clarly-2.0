// Agent (AI-owned, KnowledgeBaseModule): worker for the `kb-ingest` queue.
// Downloads the raw file (ObjectStorage, this module) and hands it to
// RetrievalModule's RetrievalIngestService (A1: chunking, embedding,
// per-tenant partition + HNSW lifecycle) — KnowledgeBaseModule owns the
// job/document lifecycle (this file), RetrievalModule owns the actual
// retrieval mechanics, per AI_PIPELINE_PLAN.md's module-boundary split.
// Same retry/backoff/failed-set-as-DLQ shape as WebhookModule's
// RespondPathProcessor (Feature 2) — a job that exhausts its attempts
// flips the document to 'failed' via onFailed(), never leaves it stuck at
// 'ingest_queued' with no signal.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppLoggerService } from '../core';
import { RetrievalIngestService } from '../retrieval/retrieval-ingest.service';
import { KB_INGEST_QUEUE } from './kb-ingest.queue';
import type { KbIngestJobData } from './kb-ingest-job.dto';
import { KbDocumentService } from './kb-document.service';
import { ObjectStorage } from '../storage/ports/object-storage.port';

@Processor(KB_INGEST_QUEUE)
export class KbIngestProcessor extends WorkerHost {
  constructor(
    private readonly kbDocuments: KbDocumentService,
    private readonly storage: ObjectStorage,
    private readonly retrievalIngest: RetrievalIngestService,
    private readonly logger: AppLoggerService,
  ) {
    super();
  }

  async process(job: Job<KbIngestJobData>): Promise<void> {
    const { tenantId, kbDocumentId, storageKey, mimeType } = job.data;

    const content = await this.storage.download(storageKey);
    const result = await this.retrievalIngest.ingestDocument({
      tenantId,
      kbDocumentId,
      content,
      mimeType,
    });

    await this.kbDocuments.markStatus(tenantId, kbDocumentId, 'ingested');

    this.logger.log(
      `kb-ingest job ${job.id} indexed ${result.chunkCount} chunk(s) for kb_document ${kbDocumentId}`,
      'KbIngestProcessor',
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<KbIngestJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    const exhausted = job.attemptsMade >= maxAttempts;

    this.logger.warn(
      `kb-ingest job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}): ${error.message}`,
      'KbIngestProcessor',
    );

    if (!exhausted) return;

    await this.kbDocuments.markStatus(
      job.data.tenantId,
      job.data.kbDocumentId,
      'failed',
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `kb-ingest worker connection error: ${error.message}`,
      error.stack,
      'KbIngestProcessor',
    );
  }
}
