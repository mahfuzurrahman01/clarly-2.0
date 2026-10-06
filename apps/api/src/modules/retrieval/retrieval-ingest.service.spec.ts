import type { Embedder } from '../llm/ports/embedder.port';
import { buildDocx, buildPdf, buildXlsx } from './__fixtures__/documents';
import { RetrievalIngestService } from './retrieval-ingest.service';
import { TextExtractionError } from './text-extraction';
import type { VectorStore } from './ports/vector-store.port';

function makeEmbedder(): { embedder: Embedder; embed: jest.Mock } {
  const embed = jest.fn().mockResolvedValue({
    values: [0.1, 0.2],
    embeddingModel: 'test',
    embeddingVersion: 'v1',
  });
  return { embedder: { embed }, embed };
}

function makeVectorStore(): {
  vectorStore: VectorStore;
  upsertChunks: jest.Mock;
} {
  const upsertChunks = jest.fn().mockResolvedValue(undefined);
  return {
    vectorStore: { upsertChunks } as unknown as VectorStore,
    upsertChunks,
  };
}

describe('RetrievalIngestService.ingestDocument()', () => {
  it('chunks the content, embeds each chunk, and upserts into the vector store', async () => {
    const { embedder, embed } = makeEmbedder();
    const { vectorStore, upsertChunks } = makeVectorStore();
    const service = new RetrievalIngestService(embedder, vectorStore);

    const result = await service.ingestDocument({
      tenantId: 'tenant-a',
      kbDocumentId: 'doc-1',
      content: Buffer.from('Refunds are processed within 5 business days.'),
      mimeType: 'text/plain',
    });

    expect(result.chunkCount).toBe(1);
    expect(embed).toHaveBeenCalledWith(
      'Refunds are processed within 5 business days.',
    );
    expect(upsertChunks).toHaveBeenCalledTimes(1);
  });

  it('each upserted chunk carries kbDocumentId and chunkIndex in metadata', async () => {
    const { embedder } = makeEmbedder();
    const { vectorStore, upsertChunks } = makeVectorStore();
    const service = new RetrievalIngestService(embedder, vectorStore);

    await service.ingestDocument({
      tenantId: 'tenant-a',
      kbDocumentId: 'doc-1',
      content: Buffer.from('Short content.'),
      mimeType: 'text/plain',
    });

    const [chunks] = upsertChunks.mock.calls[0] as [
      Array<{ metadata?: { kbDocumentId: string; chunkIndex: number } }>,
    ];
    expect(chunks[0]?.metadata).toEqual({
      kbDocumentId: 'doc-1',
      chunkIndex: 0,
    });
  });

  it('rejects an unsupported mimeType without calling the embedder or vector store', async () => {
    const { embedder, embed } = makeEmbedder();
    const { vectorStore, upsertChunks } = makeVectorStore();
    const service = new RetrievalIngestService(embedder, vectorStore);

    await expect(
      service.ingestDocument({
        tenantId: 'tenant-a',
        kbDocumentId: 'doc-1',
        content: Buffer.from('\x89PNG binary garbage'),
        mimeType: 'image/png',
      }),
    ).rejects.toThrow(/unsupported mimeType/);

    expect(embed).not.toHaveBeenCalled();
    expect(upsertChunks).not.toHaveBeenCalled();
  });

  it.each([
    ['application/pdf', () => buildPdf('Refunds take 5 business days.')],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      () => buildDocx(['Refunds take 5 business days.']),
    ],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      () => buildXlsx([{ name: 'Refunds', rows: [['Days'], [5]] }]),
    ],
  ])('extracts and indexes a %s document', async (mimeType, build) => {
    const { embedder, embed } = makeEmbedder();
    const { vectorStore, upsertChunks } = makeVectorStore();
    const service = new RetrievalIngestService(embedder, vectorStore);

    const result = await service.ingestDocument({
      tenantId: 'tenant-a',
      kbDocumentId: 'doc-1',
      content: await build(),
      mimeType,
    });

    expect(result.chunkCount).toBeGreaterThan(0);
    expect(embed).toHaveBeenCalled();
    expect(upsertChunks).toHaveBeenCalledTimes(1);
  });

  // A corrupt file throws, so KbIngestProcessor's existing failure handling
  // retries and then flips the document to 'failed' — it is never silently
  // indexed as garbage, and never left at 'ingest_queued'.
  it.each([
    ['application/pdf'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ])('fails cleanly on a corrupt %s document', async (mimeType) => {
    const { embedder, embed } = makeEmbedder();
    const { vectorStore, upsertChunks } = makeVectorStore();
    const service = new RetrievalIngestService(embedder, vectorStore);

    await expect(
      service.ingestDocument({
        tenantId: 'tenant-a',
        kbDocumentId: 'doc-1',
        content: Buffer.from('truncated nonsense'),
        mimeType,
      }),
    ).rejects.toBeInstanceOf(TextExtractionError);

    expect(embed).not.toHaveBeenCalled();
    expect(upsertChunks).not.toHaveBeenCalled();
  });

  it('returns chunkCount 0 and does not call the vector store for empty content', async () => {
    const { embedder } = makeEmbedder();
    const { vectorStore, upsertChunks } = makeVectorStore();
    const service = new RetrievalIngestService(embedder, vectorStore);

    const result = await service.ingestDocument({
      tenantId: 'tenant-a',
      kbDocumentId: 'doc-1',
      content: Buffer.from('   '),
      mimeType: 'text/plain',
    });

    expect(result.chunkCount).toBe(0);
    expect(upsertChunks).not.toHaveBeenCalled();
  });
});

describe('RetrievalIngestService.removeDocument()', () => {
  it("drops the document's chunks — kb_chunks has no FK to kb_documents, so nothing else would", async () => {
    const deleteByDocument = jest.fn().mockResolvedValue(4);
    const service = new RetrievalIngestService(makeEmbedder().embedder, {
      deleteByDocument,
    } as unknown as VectorStore);

    await expect(service.removeDocument('tenant-a', 'doc-1')).resolves.toEqual({
      chunkCount: 4,
    });
    expect(deleteByDocument).toHaveBeenCalledWith('tenant-a', 'doc-1');
  });
});
