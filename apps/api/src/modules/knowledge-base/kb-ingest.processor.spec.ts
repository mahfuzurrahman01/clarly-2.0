import type { Job } from 'bullmq';
import type { AppLoggerService } from '../core';
import type { RetrievalIngestService } from '../retrieval/retrieval-ingest.service';
import { KbIngestProcessor } from './kb-ingest.processor';
import type { KbIngestJobData } from './kb-ingest-job.dto';
import type { KbDocumentService } from './kb-document.service';
import type { ObjectStorage } from '../storage/ports/object-storage.port';

function makeJob(
  overrides: Partial<Job<KbIngestJobData>> = {},
): Job<KbIngestJobData> {
  return {
    id: 'job-1',
    data: {
      tenantId: 'tenant-a',
      kbDocumentId: 'doc-1',
      storageKey: 'tenant-a/uuid-1',
      filename: 'handbook.txt',
      mimeType: 'text/plain',
    },
    opts: { attempts: 3 },
    attemptsMade: 1,
    ...overrides,
  } as Job<KbIngestJobData>;
}

function makeKbDocuments(): {
  kbDocuments: KbDocumentService;
  markStatus: jest.Mock;
} {
  const markStatus = jest.fn().mockResolvedValue(undefined);
  return {
    kbDocuments: { markStatus } as unknown as KbDocumentService,
    markStatus,
  };
}

function makeStorage(): { storage: ObjectStorage; download: jest.Mock } {
  const download = jest
    .fn()
    .mockResolvedValue(Buffer.from('Refunds take 5 days.'));
  return { storage: { download } as unknown as ObjectStorage, download };
}

function makeRetrievalIngest(): {
  retrievalIngest: RetrievalIngestService;
  ingestDocument: jest.Mock;
} {
  const ingestDocument = jest.fn().mockResolvedValue({ chunkCount: 1 });
  return {
    retrievalIngest: { ingestDocument } as unknown as RetrievalIngestService,
    ingestDocument,
  };
}

function makeLogger(): AppLoggerService {
  return { warn: jest.fn(), log: jest.fn() } as unknown as AppLoggerService;
}

describe('KbIngestProcessor.process()', () => {
  it('downloads the file, ingests it via RetrievalModule, and marks the document ingested', async () => {
    const { kbDocuments, markStatus } = makeKbDocuments();
    const { storage, download } = makeStorage();
    const { retrievalIngest, ingestDocument } = makeRetrievalIngest();
    const processor = new KbIngestProcessor(
      kbDocuments,
      storage,
      retrievalIngest,
      makeLogger(),
    );

    await processor.process(makeJob());

    expect(download).toHaveBeenCalledWith('tenant-a/uuid-1');
    expect(ingestDocument).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      kbDocumentId: 'doc-1',
      content: Buffer.from('Refunds take 5 days.'),
      mimeType: 'text/plain',
    });
    expect(markStatus).toHaveBeenCalledWith('tenant-a', 'doc-1', 'ingested');
  });

  it('propagates an ingest failure without marking the document ingested', async () => {
    const { kbDocuments, markStatus } = makeKbDocuments();
    const { storage } = makeStorage();
    const { retrievalIngest, ingestDocument } = makeRetrievalIngest();
    ingestDocument.mockRejectedValue(new Error('embedding failed'));
    const processor = new KbIngestProcessor(
      kbDocuments,
      storage,
      retrievalIngest,
      makeLogger(),
    );

    await expect(processor.process(makeJob())).rejects.toThrow(
      'embedding failed',
    );
    expect(markStatus).not.toHaveBeenCalled();
  });
});

describe('KbIngestProcessor.onFailed()', () => {
  it('does not mark the document failed while attempts remain', async () => {
    const { kbDocuments, markStatus } = makeKbDocuments();
    const { storage } = makeStorage();
    const { retrievalIngest } = makeRetrievalIngest();
    const processor = new KbIngestProcessor(
      kbDocuments,
      storage,
      retrievalIngest,
      makeLogger(),
    );

    await processor.onFailed(
      makeJob({ attemptsMade: 1, opts: { attempts: 3 } }),
      new Error('x'),
    );

    expect(markStatus).not.toHaveBeenCalled();
  });

  it('marks the document failed once attempts are exhausted', async () => {
    const { kbDocuments, markStatus } = makeKbDocuments();
    const { storage } = makeStorage();
    const { retrievalIngest } = makeRetrievalIngest();
    const processor = new KbIngestProcessor(
      kbDocuments,
      storage,
      retrievalIngest,
      makeLogger(),
    );

    await processor.onFailed(
      makeJob({ attemptsMade: 3, opts: { attempts: 3 } }),
      new Error('x'),
    );

    expect(markStatus).toHaveBeenCalledWith('tenant-a', 'doc-1', 'failed');
  });

  it('is a no-op when job is undefined', async () => {
    const { kbDocuments, markStatus } = makeKbDocuments();
    const { storage } = makeStorage();
    const { retrievalIngest } = makeRetrievalIngest();
    const processor = new KbIngestProcessor(
      kbDocuments,
      storage,
      retrievalIngest,
      makeLogger(),
    );

    await expect(
      processor.onFailed(undefined, new Error('x')),
    ).resolves.toBeUndefined();
    expect(markStatus).not.toHaveBeenCalled();
  });
});
