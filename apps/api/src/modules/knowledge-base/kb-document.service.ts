// Agent (AI-owned, KnowledgeBaseModule): KB CRUD + ingest job enqueue (A1's
// upstream). "KB upload mechanism via Supabase Storage feeding A1 ingest
// (no onboarding UX — direct upload/seed only)" per the former feature plan's
// Feature 2.5 — this is the "direct upload/seed" mechanism; Feature 6
// wraps it with a real UI later, no new mechanism needed then.
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { kbDocuments } from '../persistence/drizzle/schema';
import { AppLoggerService } from '../core';
import { RetrievalIngestService } from '../retrieval/retrieval-ingest.service';
import { TenantContextService } from '../tenant-context/tenant-context.service';
import type { KbDocumentRecord } from './kb-document.dto';
import type { KbIngestJobData } from './kb-ingest-job.dto';
import { KB_INGEST_QUEUE } from './kb-ingest.queue';
import { ObjectStorage } from '../storage/ports/object-storage.port';

@Injectable()
export class KbDocumentService {
  constructor(
    private readonly storage: ObjectStorage,
    private readonly tenantContext: TenantContextService,
    private readonly retrievalIngest: RetrievalIngestService,
    private readonly logger: AppLoggerService,
    @InjectQueue(KB_INGEST_QUEUE)
    private readonly ingestQueue: Queue<KbIngestJobData>,
  ) {}

  /**
   * Stores the raw file, registers a kb_documents row, and enqueues the
   * ingest job — the whole "direct upload/seed" path in one call. Feature
   * 3's A1 pipeline is the eventual queue consumer that turns this into
   * actual chunks/embeddings (D3's kb_chunks, not touched here — rule 3
   * keeps pgvector types out of this module regardless).
   */
  async upload(
    tenantId: string,
    filename: string,
    mimeType: string,
    content: Buffer,
  ): Promise<KbDocumentRecord> {
    const stored = await this.storage.upload(tenantId, filename, content);

    const [row] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .insert(kbDocuments)
          .values({
            tenantId,
            filename,
            storageKey: stored.storageKey,
            mimeType,
            sizeBytes: stored.sizeBytes,
            status: 'uploaded',
          })
          .returning(),
      tenantId,
    );

    await this.ingestQueue.add(
      'ingest',
      {
        tenantId,
        kbDocumentId: row.id,
        storageKey: row.storageKey,
        filename: row.filename,
        mimeType: row.mimeType,
      },
      { jobId: row.id },
    );

    const [queued] = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(kbDocuments)
          .set({ status: 'ingest_queued', updatedAt: new Date() })
          .where(eq(kbDocuments.id, row.id))
          .returning(),
      tenantId,
    );

    return toRecord(queued);
  }

  async markStatus(
    tenantId: string,
    kbDocumentId: string,
    status: KbDocumentRecord['status'],
  ): Promise<void> {
    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .update(kbDocuments)
          .set({ status, updatedAt: new Date() })
          .where(eq(kbDocuments.id, kbDocumentId)),
      tenantId,
    );
  }

  async getForTenant(
    tenantId: string,
    kbDocumentId: string,
  ): Promise<KbDocumentRecord> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .select()
          .from(kbDocuments)
          .where(
            and(
              eq(kbDocuments.id, kbDocumentId),
              eq(kbDocuments.tenantId, tenantId),
            ),
          ),
      tenantId,
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(`KB document ${kbDocumentId} not found`);
    }
    return toRecord(row);
  }

  /**
   * Removes a document everywhere it exists: the queued ingest job, the
   * registry row (which cascades `agent_kb_documents`), the retrieval
   * chunks, and finally the stored bytes.
   *
   * Order is deliberate:
   *
   * 1. **Drop the queued job first.** Otherwise a job still waiting in
   *    `kb-ingest` would re-index the document seconds after it was
   *    deleted, and the tenant would watch deleted content come back.
   * 2. **Delete the registry row** — the record of truth. Nothing after
   *    this point can resurrect the document, only leave debris.
   * 3. **Delete the chunks**, which is what actually stops the agent
   *    quoting the document. `kb_chunks` has no FK to `kb_documents`
   *    (hand-authored, LIST-partitioned) so no cascade does this for us.
   * 4. **Delete the object**, best-effort. A failed object delete leaks
   *    bytes; failing the request after the row is gone would leave the
   *    tenant unable to retry a delete that already mostly happened. The
   *    same trade-off T16's transcript purge makes.
   *
   * A job that is already *running* can still lose the race and write
   * chunks after step 3. It cannot resurrect the row, so the worst case is
   * orphaned chunks scoped to an id no document claims — retrieval joins
   * nothing to them for citation, and a repeat delete clears them.
   */
  /**
   * Returns what was deleted, plus how many retrieval chunks went with it.
   * The document is already loaded here to find its storage key, so handing it
   * back costs nothing and saves the caller a second read — the audit trail
   * wants the filename, not just the uuid.
   */
  async delete(
    tenantId: string,
    kbDocumentId: string,
  ): Promise<{ filename: string; chunkCount: number }> {
    const document = await this.getForTenant(tenantId, kbDocumentId);

    await this.removeQueuedIngestJob(kbDocumentId);

    await this.tenantContext.withTenantTx(
      (tx) =>
        tx
          .delete(kbDocuments)
          .where(
            and(
              eq(kbDocuments.id, kbDocumentId),
              eq(kbDocuments.tenantId, tenantId),
            ),
          ),
      tenantId,
    );

    const { chunkCount } = await this.retrievalIngest.removeDocument(
      tenantId,
      kbDocumentId,
    );

    try {
      await this.storage.delete(document.storageKey);
    } catch (error) {
      this.logger.error(
        `Deleted kb_document ${kbDocumentId} but failed to remove object ${document.storageKey}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        undefined,
        'KbDocumentService',
      );
    }

    this.logger.log(
      `Deleted kb_document ${kbDocumentId} (${chunkCount} chunk(s) removed) for tenant ${tenantId}`,
      'KbDocumentService',
    );

    return { filename: document.filename, chunkCount };
  }

  /** Best-effort: the job may have already completed, failed, or been removed — none of which should block the delete. */
  private async removeQueuedIngestJob(kbDocumentId: string): Promise<void> {
    try {
      await this.ingestQueue.remove(kbDocumentId);
    } catch (error) {
      this.logger.warn(
        `Could not remove kb-ingest job ${kbDocumentId} before deleting the document: ${
          error instanceof Error ? error.message : String(error)
        }`,
        'KbDocumentService',
      );
    }
  }

  async listForTenant(tenantId: string): Promise<KbDocumentRecord[]> {
    const rows = await this.tenantContext.withTenantTx(
      (tx) =>
        tx.select().from(kbDocuments).where(eq(kbDocuments.tenantId, tenantId)),
      tenantId,
    );
    return rows.map(toRecord);
  }
}

function toRecord(row: typeof kbDocuments.$inferSelect): KbDocumentRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    filename: row.filename,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    status: row.status as KbDocumentRecord['status'],
  };
}
