import { NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { KbDocumentService } from './kb-document.service';
import type { KbIngestJobData } from './kb-ingest-job.dto';
import type { ObjectStorage } from '../storage/ports/object-storage.port';
import type { AppLoggerService } from '../core';
import type { RetrievalIngestService } from '../retrieval/retrieval-ingest.service';

const TENANT_A = 'tenant-a';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    tenantId: TENANT_A,
    filename: 'handbook.pdf',
    storageKey: 'tenant-a/uuid-1',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    status: 'uploaded',
    ...overrides,
  };
}

/**
 * A real withTenantTx() opens a transaction and invokes the caller's
 * callback with a Drizzle `tx`. Returning a canned value from
 * withTenantTx() itself (as earlier specs in this repo did) never executes
 * that callback, so the query-builder logic inside it — the actual thing
 * under test — gets zero coverage. This stub instead calls through to the
 * real callback against a fake `tx` matching exactly the chain
 * KbDocumentService uses (insert/update/select), so the arrow-function
 * bodies really run.
 */
function makeTenantContext(rowsToReturn: unknown[][]): {
  tenantContext: TenantContextService;
  withTenantTx: jest.Mock;
} {
  let call = 0;
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const rows = rowsToReturn[call++] ?? [];
    const tx = {
      insert: () => ({
        values: () => ({ returning: () => Promise.resolve(rows) }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve(rows) }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(rows),
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve),
        }),
      }),
      delete: () => ({ where: () => Promise.resolve({ rowCount: 1 }) }),
    };
    return fn(tx);
  });
  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    withTenantTx,
  };
}

function makeStorage(
  storageKey: string,
  sizeBytes: number,
): { storage: ObjectStorage; upload: jest.Mock } {
  const upload = jest.fn().mockResolvedValue({ storageKey, sizeBytes });
  return { storage: { upload } as unknown as ObjectStorage, upload };
}

function makeQueue(): { queue: Queue<KbIngestJobData>; add: jest.Mock } {
  const add = jest.fn().mockResolvedValue(undefined);
  return { queue: { add } as unknown as Queue<KbIngestJobData>, add };
}

function makeRetrieval(): {
  retrieval: RetrievalIngestService;
  removeDocument: jest.Mock;
} {
  const removeDocument = jest.fn().mockResolvedValue({ chunkCount: 0 });
  return {
    retrieval: { removeDocument } as unknown as RetrievalIngestService,
    removeDocument,
  };
}

function makeLogger(): { logger: AppLoggerService; error: jest.Mock } {
  const error = jest.fn();
  return {
    logger: {
      log: jest.fn(),
      warn: jest.fn(),
      error,
    } as unknown as AppLoggerService,
    error,
  };
}

/** Positional constructor wrapper so the specs that predate the delete path do not each have to name the retrieval/logger dependencies they never exercise. */
function makeService(
  storage: ObjectStorage,
  tenantContext: TenantContextService,
  queue: Queue<KbIngestJobData>,
  retrieval: RetrievalIngestService = makeRetrieval().retrieval,
  logger: AppLoggerService = makeLogger().logger,
): KbDocumentService {
  return new KbDocumentService(
    storage,
    tenantContext,
    retrieval,
    logger,
    queue,
  );
}

describe('KbDocumentService.upload()', () => {
  it('stores the file, registers a kb_documents row, and returns it as ingest_queued', async () => {
    const uploadedRow = makeRow();
    const { tenantContext } = makeTenantContext([
      [uploadedRow],
      [{ ...uploadedRow, status: 'ingest_queued' }],
    ]);
    const { storage } = makeStorage(
      uploadedRow.storageKey,
      uploadedRow.sizeBytes,
    );
    const { queue } = makeQueue();
    const service = makeService(storage, tenantContext, queue);

    const record = await service.upload(
      TENANT_A,
      'handbook.pdf',
      'application/pdf',
      Buffer.from('x'),
    );

    expect(record).toEqual({
      id: 'doc-1',
      tenantId: TENANT_A,
      filename: 'handbook.pdf',
      storageKey: 'tenant-a/uuid-1',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      status: 'ingest_queued',
    });
  });

  it('enqueues a kb-ingest job carrying the document contract', async () => {
    const uploadedRow = makeRow();
    const { tenantContext } = makeTenantContext([
      [uploadedRow],
      [{ ...uploadedRow, status: 'ingest_queued' }],
    ]);
    const { storage } = makeStorage(
      uploadedRow.storageKey,
      uploadedRow.sizeBytes,
    );
    const { queue, add } = makeQueue();
    const service = makeService(storage, tenantContext, queue);

    await service.upload(
      TENANT_A,
      'handbook.pdf',
      'application/pdf',
      Buffer.from('x'),
    );

    expect(add).toHaveBeenCalledWith(
      'ingest',
      {
        tenantId: TENANT_A,
        kbDocumentId: 'doc-1',
        storageKey: 'tenant-a/uuid-1',
        filename: 'handbook.pdf',
        mimeType: 'application/pdf',
      },
      { jobId: 'doc-1' },
    );
  });

  it('passes the raw content straight through to ObjectStorage', async () => {
    const uploadedRow = makeRow();
    const { tenantContext } = makeTenantContext([[uploadedRow], [uploadedRow]]);
    const { storage, upload } = makeStorage(
      uploadedRow.storageKey,
      uploadedRow.sizeBytes,
    );
    const { queue } = makeQueue();
    const service = makeService(storage, tenantContext, queue);

    await service.upload(
      TENANT_A,
      'handbook.pdf',
      'application/pdf',
      Buffer.from('content'),
    );

    expect(upload).toHaveBeenCalledWith(
      TENANT_A,
      'handbook.pdf',
      Buffer.from('content'),
    );
  });
});

describe('KbDocumentService.listForTenant()', () => {
  it('maps every row to a KbDocumentRecord, scoped via withTenantTx', async () => {
    const row = makeRow();
    const { tenantContext, withTenantTx } = makeTenantContext([[row]]);
    const service = makeService(
      {} as unknown as ObjectStorage,
      tenantContext,
      {} as unknown as Queue<KbIngestJobData>,
    );

    const records = await service.listForTenant(TENANT_A);

    expect(records).toEqual([
      {
        id: 'doc-1',
        tenantId: TENANT_A,
        filename: 'handbook.pdf',
        storageKey: 'tenant-a/uuid-1',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        status: 'uploaded',
      },
    ]);
    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
  });

  it('returns an empty array when the tenant has no documents', async () => {
    const { tenantContext } = makeTenantContext([[]]);
    const service = makeService(
      {} as unknown as ObjectStorage,
      tenantContext,
      {} as unknown as Queue<KbIngestJobData>,
    );

    await expect(service.listForTenant(TENANT_A)).resolves.toEqual([]);
  });
});

describe('KbDocumentService.markStatus()', () => {
  it('writes the status through withTenantTx, scoped to the tenant', async () => {
    const { tenantContext, withTenantTx } = makeTenantContext([[]]);
    const service = makeService(
      {} as unknown as ObjectStorage,
      tenantContext,
      {} as unknown as Queue<KbIngestJobData>,
    );

    await service.markStatus(TENANT_A, 'doc-1', 'failed');

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
  });
});

describe('KbDocumentService.getForTenant()', () => {
  it('returns the document when it belongs to the tenant', async () => {
    const { tenantContext, withTenantTx } = makeTenantContext([[makeRow()]]);
    const service = makeService(
      {} as unknown as ObjectStorage,
      tenantContext,
      {} as unknown as Queue<KbIngestJobData>,
    );

    await expect(
      service.getForTenant(TENANT_A, 'doc-1'),
    ).resolves.toMatchObject({ id: 'doc-1', status: 'uploaded' });
    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
  });

  it("404s rather than leaking that another tenant's document exists", async () => {
    const { tenantContext } = makeTenantContext([[]]);
    const service = makeService(
      {} as unknown as ObjectStorage,
      tenantContext,
      {} as unknown as Queue<KbIngestJobData>,
    );

    await expect(service.getForTenant(TENANT_A, 'doc-1')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('KbDocumentService.delete()', () => {
  function makeDeleteHarness() {
    // Two withTenantTx calls: the existence read, then the row delete.
    const { tenantContext, withTenantTx } = makeTenantContext([
      [makeRow()],
      [],
    ]);
    const storageDelete = jest.fn().mockResolvedValue(undefined);
    const remove = jest.fn().mockResolvedValue(undefined);
    const { retrieval, removeDocument } = makeRetrieval();
    const { logger, error: loggedError } = makeLogger();
    const service = makeService(
      { delete: storageDelete } as unknown as ObjectStorage,
      tenantContext,
      { remove } as unknown as Queue<KbIngestJobData>,
      retrieval,
      logger,
    );
    return {
      service,
      storageDelete,
      remove,
      removeDocument,
      loggedError,
      withTenantTx,
    };
  }

  it('deletes the chunks, so a deleted document can no longer be retrieved', async () => {
    const { service, removeDocument } = makeDeleteHarness();

    await service.delete(TENANT_A, 'doc-1');

    expect(removeDocument).toHaveBeenCalledWith(TENANT_A, 'doc-1');
  });

  it('cancels a still-queued ingest job, so the document cannot be re-indexed after deletion', async () => {
    const { service, remove } = makeDeleteHarness();

    await service.delete(TENANT_A, 'doc-1');

    expect(remove).toHaveBeenCalledWith('doc-1');
  });

  it('deletes the stored object, so the bytes do not outlive the record', async () => {
    const { service, storageDelete } = makeDeleteHarness();

    await service.delete(TENANT_A, 'doc-1');

    expect(storageDelete).toHaveBeenCalledWith('tenant-a/uuid-1');
  });

  it('still succeeds when object storage refuses, rather than leaving a half-deleted document the tenant cannot retry', async () => {
    const { service, storageDelete, loggedError } = makeDeleteHarness();
    storageDelete.mockRejectedValue(new Error('bucket unreachable'));

    const deleted = await service.delete(TENANT_A, 'doc-1');
    expect(typeof deleted.filename).toBe('string');
    expect(loggedError).toHaveBeenCalled();
  });

  it('does not touch chunks or storage when the document is not the tenant’s', async () => {
    const { tenantContext } = makeTenantContext([[]]);
    const storageDelete = jest.fn();
    const { retrieval, removeDocument } = makeRetrieval();
    const service = makeService(
      { delete: storageDelete } as unknown as ObjectStorage,
      tenantContext,
      { remove: jest.fn() } as unknown as Queue<KbIngestJobData>,
      retrieval,
    );

    await expect(service.delete(TENANT_A, 'doc-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(removeDocument).not.toHaveBeenCalled();
    expect(storageDelete).not.toHaveBeenCalled();
  });

  it('deletes the document even when the ingest job is already gone', async () => {
    const { service, remove, removeDocument } = makeDeleteHarness();
    remove.mockRejectedValue(new Error('job not found'));

    const deleted = await service.delete(TENANT_A, 'doc-1');
    expect(typeof deleted.filename).toBe('string');
    expect(removeDocument).toHaveBeenCalled();
  });
});
