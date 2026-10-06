// A1: the real consumer KnowledgeBaseModule's `kb-ingest` queue (Feature
// 2.5) was built for — chunk -> embed each chunk -> upsert into pgvector
// (partition lifecycle handled by PgVectorStore/PartitionLifecycleService,
// not this service). KnowledgeBaseModule's KbIngestProcessor calls this
// directly (KnowledgeBaseModule importing RetrievalModule is fine — no
// enforced rule forbids it, only the reverse-ish rules 1/2 about
// ToolExecutionModule/LlmModule).
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Embedder } from '../llm/ports/embedder.port';
import { chunkText } from './chunking';
import { VectorStore, type VectorStoreChunk } from './ports/vector-store.port';
import {
  SUPPORTED_MIME_TYPES_DESCRIPTION,
  extractText,
  isSupportedMimeType,
} from './text-extraction';

export interface IngestDocumentInput {
  tenantId: string;
  kbDocumentId: string;
  content: Buffer;
  mimeType: string;
}

export interface IngestDocumentResult {
  chunkCount: number;
}

@Injectable()
export class RetrievalIngestService {
  constructor(
    private readonly embedder: Embedder,
    private readonly vectorStore: VectorStore,
  ) {}

  async ingestDocument(
    input: IngestDocumentInput,
  ): Promise<IngestDocumentResult> {
    if (!isSupportedMimeType(input.mimeType)) {
      // KbDocumentService.upload() (Feature 2.5) accepts any mimeType
      // without validation; this is the last point in the pipeline where an
      // unsupported type is rejected, loudly, rather than silently
      // mis-chunking raw bytes as text. KbDocumentController rejects the
      // same set at upload time using the same predicate.
      throw new Error(
        `RetrievalIngestService: unsupported mimeType "${input.mimeType}" (supported: ${SUPPORTED_MIME_TYPES_DESCRIPTION})`,
      );
    }

    // Throws TextExtractionError on a corrupt/unreadable file. KbIngestProcessor
    // treats that like any other job failure: retried, then the document flips
    // to 'failed' once attempts are exhausted (a corrupt file fails identically
    // on every attempt, so it lands in 'failed' rather than stuck in queue).
    const text = await extractText(input.content, input.mimeType);

    const chunks = chunkText(text);
    if (chunks.length === 0) {
      return { chunkCount: 0 };
    }

    const vectorStoreChunks: VectorStoreChunk[] = [];
    for (const [index, chunkContent] of chunks.entries()) {
      const embedding = await this.embedder.embed(chunkContent);
      vectorStoreChunks.push({
        id: randomUUID(),
        tenantId: input.tenantId,
        content: chunkContent,
        embedding: embedding.values,
        embeddingModel: embedding.embeddingModel,
        embeddingVersion: embedding.embeddingVersion,
        metadata: { kbDocumentId: input.kbDocumentId, chunkIndex: index },
      });
    }

    await this.vectorStore.upsertChunks(vectorStoreChunks);

    return { chunkCount: vectorStoreChunks.length };
  }

  /**
   * The inverse of ingestDocument(): drops the document's chunks so the
   * agent stops retrieving from a document its tenant has deleted.
   * kb_chunks has no foreign key to kb_documents (it is LIST-partitioned
   * and hand-authored, outside drizzle-kit's diff), so nothing removes
   * these rows on its own — deleting the kb_documents row alone would
   * leave the content answerable forever.
   */
  async removeDocument(
    tenantId: string,
    kbDocumentId: string,
  ): Promise<{ chunkCount: number }> {
    const chunkCount = await this.vectorStore.deleteByDocument(
      tenantId,
      kbDocumentId,
    );
    return { chunkCount };
  }
}
