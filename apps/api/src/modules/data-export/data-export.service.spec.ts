import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { AppConfigService, AppLoggerService } from '../core';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import type { TenantDirectoryService } from '../tenant-context/tenant-directory';
import type { DataExportAssemblerService } from './data-export-assembler.service';
import { DataExportService } from './data-export.service';

const TENANT = 'tenant-a';
const EXPORT_ID = 'export-1';

function chain(resolveWith: unknown): Record<string, unknown> {
  const node: Record<string, unknown> = {
    from: () => node,
    where: () => node,
    orderBy: () => node,
    limit: () => node,
    set: () => node,
    values: () => node,
    returning: () => node,
    then: (onFulfilled: (value: unknown) => unknown): Promise<unknown> =>
      Promise.resolve(resolveWith).then(onFulfilled),
  };
  return node;
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXPORT_ID,
    tenantId: TENANT,
    requestedBy: 'admin-1',
    status: 'ready',
    storageKey: 'exports/bundle.json',
    sizeBytes: '2048',
    rowCounts: { messages: 3 },
    error: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    createdAt: new Date('2026-08-22T10:00:00Z'),
    completedAt: new Date('2026-08-22T10:01:00Z'),
    ...overrides,
  };
}

function makeHarness(options: {
  txResponses?: unknown[];
  /**
   * purgeExpired's per-tenant read: the first transaction opened for a
   * tenant listed here answers with its due rows; every later transaction
   * falls through to `txResponses`.
   */
  dueByTenant?: Record<string, unknown[]>;
  tenantIds?: string[];
  download?: Buffer;
  uploadThrows?: Error;
  assembleThrows?: Error;
}) {
  const txResponses = options.txResponses ?? [];
  let txCall = 0;
  const dueByTenant = options.dueByTenant ?? {};
  const dueServed = new Set<string>();
  const withTenantTx = jest.fn(
    (fn: (tx: unknown) => unknown, tenantId?: string) => {
      let response: unknown;
      if (tenantId && tenantId in dueByTenant && !dueServed.has(tenantId)) {
        dueServed.add(tenantId);
        response = dueByTenant[tenantId];
      } else {
        response = txResponses[txCall++];
      }
      return fn({
        select: () => chain(response),
        insert: () => chain(response),
        update: () => chain(response),
      });
    },
  );

  const listTenantIds = jest
    .fn()
    .mockResolvedValue(options.tenantIds ?? Object.keys(dueByTenant));

  const add = jest.fn().mockResolvedValue(undefined);
  const storageDelete = jest.fn().mockResolvedValue(undefined);
  const upload = options.uploadThrows
    ? jest.fn().mockRejectedValue(options.uploadThrows)
    : jest
        .fn()
        .mockResolvedValue({ storageKey: 'exports/b.json', sizeBytes: 10 });
  const assemble = options.assembleThrows
    ? jest.fn().mockRejectedValue(options.assembleThrows)
    : jest.fn().mockResolvedValue({
        content: Buffer.from('{}'),
        rowCounts: { messages: 3 },
      });

  const error = jest.fn();
  const service = new DataExportService(
    { add } as unknown as Queue,
    { withTenantTx } as unknown as TenantContextService,
    { listTenantIds } as unknown as TenantDirectoryService,
    { assemble } as unknown as DataExportAssemblerService,
    {
      upload,
      download: jest
        .fn()
        .mockResolvedValue(options.download ?? Buffer.from('{}')),
      delete: storageDelete,
    },
    { dataExportTtlDays: 7 } as unknown as AppConfigService,
    { warn: jest.fn(), log: jest.fn(), error } as unknown as AppLoggerService,
  );

  return {
    service,
    add,
    upload,
    assemble,
    storageDelete,
    withTenantTx,
    listTenantIds,
    error,
  };
}

describe('DataExportService.request()', () => {
  it('queues a job for the new export', async () => {
    const { service, add } = makeHarness({
      txResponses: [[], [makeRow({ status: 'pending' })]],
    });

    const record = await service.request(TENANT, 'admin-1');

    expect(record.status).toBe('pending');
    expect(add).toHaveBeenCalledWith('assemble-export', {
      tenantId: TENANT,
      exportId: EXPORT_ID,
    });
  });

  // Assembling reads every row the tenant owns. A console that retries on a
  // slow response would otherwise queue a stack of full-table scans.
  it('refuses a second export while one is still in flight', async () => {
    const { service, add } = makeHarness({
      txResponses: [[makeRow({ status: 'running', createdAt: new Date() })]],
    });

    await expect(service.request(TENANT, 'admin-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(add).not.toHaveBeenCalled();
  });

  // The in-flight guard on its own is a trap: a job lost to a worker crash
  // leaves a row stuck at `pending` and locks the tenant out of Article 15
  // permanently. One that has gone an hour without finishing is gone.
  it('supersedes an in-flight export that never finished, and queues the new one', async () => {
    const abandoned = makeRow({
      status: 'pending',
      createdAt: new Date(Date.now() - 7_200_000),
    });
    const { service, add, withTenantTx } = makeHarness({
      txResponses: [[abandoned], [], [makeRow({ status: 'pending' })]],
    });

    const record = await service.request(TENANT, 'admin-1');

    expect(record.status).toBe('pending');
    expect(add).toHaveBeenCalledTimes(1);
    // The abandoned row is closed out as failed rather than left dangling.
    expect(withTenantTx).toHaveBeenCalledTimes(3);
  });
});

describe('DataExportService.runExport()', () => {
  it('assembles, uploads, and stamps the row ready with an expiry', async () => {
    const { service, upload, withTenantTx } = makeHarness({
      txResponses: [[], []],
    });

    await service.runExport(TENANT, EXPORT_ID);

    expect(upload).toHaveBeenCalledWith(
      TENANT,
      `data-export-${EXPORT_ID}.json`,
      expect.any(Buffer),
    );
    // running, then ready
    expect(withTenantTx).toHaveBeenCalledTimes(2);
  });

  // A tenant waiting on a legal obligation must be told it went wrong, not
  // left polling a row that never changes.
  it('records the failure on the row and rethrows', async () => {
    const { service, error } = makeHarness({
      txResponses: [[], []],
      assembleThrows: new Error('pool exhausted'),
    });

    await expect(service.runExport(TENANT, EXPORT_ID)).rejects.toThrow(
      'pool exhausted',
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('failed'),
      'DataExportService',
    );
  });
});

describe('DataExportService.download()', () => {
  it('serves a ready bundle', async () => {
    const { service } = makeHarness({
      txResponses: [[makeRow()]],
      download: Buffer.from('{"formatVersion":1}'),
    });

    const result = await service.download(TENANT, EXPORT_ID);

    expect(result.filename).toBe(`export-${EXPORT_ID}.json`);
    expect(result.content.toString()).toContain('formatVersion');
  });

  it('404s for an export that is not this tenant’s', async () => {
    const { service } = makeHarness({ txResponses: [[]] });

    await expect(service.download(TENANT, EXPORT_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // The export exists, it just cannot be handed over — 409, not 404.
  it('refuses while still running', async () => {
    const { service } = makeHarness({
      txResponses: [[makeRow({ status: 'running', storageKey: null })]],
    });

    await expect(service.download(TENANT, EXPORT_ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  // The sweep may not have run yet, but an expired bundle must not be served
  // just because its row is still around.
  it('refuses an expired bundle even before the sweep deletes it', async () => {
    const { service } = makeHarness({
      txResponses: [[makeRow({ expiresAt: new Date(Date.now() - 1000) })]],
    });

    await expect(service.download(TENANT, EXPORT_ID)).rejects.toThrow(
      /expired/i,
    );
  });
});

describe('DataExportService.purgeExpired()', () => {
  it('deletes the bundle and clears the key, keeping the record', async () => {
    const { service, storageDelete, withTenantTx } = makeHarness({
      dueByTenant: {
        [TENANT]: [
          { id: EXPORT_ID, tenantId: TENANT, storageKey: 'exports/b.json' },
        ],
      },
      txResponses: [[]],
    });

    await expect(service.purgeExpired()).resolves.toEqual({ purged: 1 });
    expect(storageDelete).toHaveBeenCalledWith('exports/b.json');
    // The read and the key-clearing update both run under the row's tenant.
    expect(withTenantTx).toHaveBeenCalledTimes(2);
    for (const call of withTenantTx.mock.calls) {
      expect(call[1]).toBe(TENANT);
    }
  });

  // `data_exports` is FORCE RLS: a platform-wide read returned nothing, so
  // the purge must enter every tenant — closed ones included, since their
  // export copies must still expire.
  it('reads due rows tenant by tenant, including closed workspaces', async () => {
    const { service, storageDelete, listTenantIds, withTenantTx } = makeHarness(
      {
        dueByTenant: {
          [TENANT]: [
            { id: 'export-a', tenantId: TENANT, storageKey: 'exports/a.json' },
          ],
          'tenant-closed': [
            {
              id: 'export-c',
              tenantId: 'tenant-closed',
              storageKey: 'exports/c.json',
            },
          ],
          'tenant-empty': [],
        },
        txResponses: [[], []],
      },
    );

    await expect(service.purgeExpired()).resolves.toEqual({ purged: 2 });

    expect(listTenantIds).toHaveBeenCalledWith({ includeClosed: true });
    const readTenants = withTenantTx.mock.calls
      .slice(0, 3)
      .map((call) => call[1])
      .sort();
    expect(readTenants).toEqual(['tenant-a', 'tenant-closed', 'tenant-empty']);
    expect(storageDelete).toHaveBeenCalledWith('exports/a.json');
    expect(storageDelete).toHaveBeenCalledWith('exports/c.json');
    // Each key is cleared under its own tenant, never another's.
    const updateTenants = withTenantTx.mock.calls.slice(3).map((c) => c[1]);
    expect(updateTenants.sort()).toEqual(['tenant-a', 'tenant-closed']);
  });

  it('does nothing when there are no tenants', async () => {
    const { service, storageDelete, withTenantTx } = makeHarness({
      tenantIds: [],
    });

    await expect(service.purgeExpired()).resolves.toEqual({ purged: 0 });
    expect(withTenantTx).not.toHaveBeenCalled();
    expect(storageDelete).not.toHaveBeenCalled();
  });

  // Clearing the key on a failed delete would orphan the object forever.
  it('leaves the row alone when the object cannot be deleted, so the next sweep retries', async () => {
    const { service, withTenantTx } = makeHarness({
      dueByTenant: {
        [TENANT]: [
          { id: EXPORT_ID, tenantId: TENANT, storageKey: 'exports/b.json' },
        ],
      },
    });
    // Storage delete rejects on this run.
    (service as unknown as { storage: { delete: jest.Mock } }).storage.delete =
      jest.fn().mockRejectedValue(new Error('bucket unreachable'));

    await expect(service.purgeExpired()).resolves.toEqual({ purged: 0 });
    // Only the read — no update clearing the key.
    expect(withTenantTx).toHaveBeenCalledTimes(1);
  });
});
