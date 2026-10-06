// F24: `store_sync_jobs` shipped in migration 0052 with an RLS policy, two
// indexes and no writer. These tests pin the two things that made that a bug
// worth fixing: the rows are written, and they are written tenant-scoped.
import type { AppLoggerService } from '../core';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { StoreSyncJobService } from './store-sync-job.service';

function makeLogger(): AppLoggerService {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLoggerService;
}

function makeService(withTenantTx: jest.Mock): StoreSyncJobService {
  return new StoreSyncJobService(
    { withTenantTx } as unknown as TenantContextService,
    makeLogger(),
  );
}

describe('StoreSyncJobService', () => {
  it('queues a job as pending and returns its id', async () => {
    const withTenantTx = jest.fn().mockResolvedValue([{ id: 'job-1' }]);
    const service = makeService(withTenantTx);

    await expect(
      service.enqueue('tenant-a', 'conn-1', 'product_sync'),
    ).resolves.toBe('job-1');
  });

  it('scopes every write to the tenant via withTenantTx, so RLS applies at all', async () => {
    const withTenantTx = jest.fn().mockResolvedValue([{ id: 'job-1' }]);
    const service = makeService(withTenantTx);

    await service.enqueue('tenant-a', 'conn-1', 'product_sync');
    await service.markRunning('tenant-a', 'job-1');
    await service.markCompleted('tenant-a', 'job-1', {
      synced: 3,
      updated: 1,
      errors: 0,
    });
    await service.markFailed('tenant-a', 'job-1', 'boom', {
      synced: 0,
      errors: 1,
    });

    expect(withTenantTx).toHaveBeenCalledTimes(4);
    for (const call of withTenantTx.mock.calls as unknown[][]) {
      expect(call[1]).toBe('tenant-a');
    }
  });

  it('never lets a bookkeeping failure escape into the sync path', async () => {
    const withTenantTx = jest.fn().mockRejectedValue(new Error('db down'));
    const service = makeService(withTenantTx);

    await expect(
      service.enqueue('tenant-a', 'conn-1', 'product_sync'),
    ).resolves.toBeNull();
    await expect(
      service.markRunning('tenant-a', 'job-1'),
    ).resolves.toBeUndefined();
    await expect(
      service.markCompleted('tenant-a', 'job-1', {
        synced: 0,
        updated: 0,
        errors: 0,
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.markFailed('tenant-a', 'job-1', 'boom', { synced: 0, errors: 1 }),
    ).resolves.toBeUndefined();
  });

  it('returns null rather than undefined when the insert wrote no row', async () => {
    const service = makeService(jest.fn().mockResolvedValue([]));
    await expect(
      service.enqueue('tenant-a', 'conn-1', 'product_sync'),
    ).resolves.toBeNull();
  });

  it('truncates an unbounded provider error before it reaches the column', async () => {
    const captured: Record<string, unknown>[] = [];
    const withTenantTx: jest.Mock = jest.fn(
      async (fn: (tx: unknown) => unknown) => {
        // The update builder is exercised through a minimal stub so the `set`
        // payload — the thing under test — is observable.
        const tx = {
          update: () => ({
            set: (values: Record<string, unknown>) => {
              captured.push(values);
              return { where: () => Promise.resolve(undefined) };
            },
          }),
        };
        return await fn(tx);
      },
    );
    const service = makeService(withTenantTx);

    await service.markFailed('tenant-a', 'job-1', 'x'.repeat(5000), {
      synced: 0,
      errors: 1,
    });

    const [set] = captured;
    expect((set.errorMessage as string).length).toBe(1000);
  });

  it('reads back the latest job and defaults null counts to zero', async () => {
    const withTenantTx = jest.fn().mockResolvedValue([
      {
        id: 'job-1',
        tenantId: 'tenant-a',
        storeConnectionId: 'conn-1',
        jobType: 'product_sync',
        status: 'completed',
        productsSynced: null,
        productsUpdated: null,
        productsFailed: null,
        errorMessage: null,
        startedAt: null,
        completedAt: null,
        createdAt: new Date('2026-09-21T00:00:00Z'),
      },
    ]);
    const service = makeService(withTenantTx);

    await expect(
      service.findLatestForConnection('tenant-a', 'conn-1'),
    ).resolves.toMatchObject({
      id: 'job-1',
      status: 'completed',
      productsSynced: 0,
      productsFailed: 0,
    });
  });

  it('returns null when the connection has never synced', async () => {
    const service = makeService(jest.fn().mockResolvedValue([]));
    await expect(
      service.findLatestForConnection('tenant-a', 'conn-1'),
    ).resolves.toBeNull();
  });

  // Phase 6 review finding 7: this read decorates GET /store/connections.
  // Before, it was the one method without a try/catch, so a transient DB
  // error on the bookkeeping read 500'd the connection list itself.
  it('swallows a failed read too — bookkeeping must not 500 the connection list', async () => {
    const service = makeService(
      jest.fn().mockRejectedValue(new Error('db down')),
    );
    await expect(
      service.findLatestForConnection('tenant-a', 'conn-1'),
    ).resolves.toBeNull();
  });

  // F24 follow-up: `products_updated` is now a real count (StoreSyncService
  // reports insert-vs-update via CatalogService.upsertProductDetailed), not
  // the column default.
  it('persists the created/updated split on completion', async () => {
    const captured: Record<string, unknown>[] = [];
    const withTenantTx: jest.Mock = jest.fn(
      async (fn: (tx: unknown) => unknown) => {
        const tx = {
          update: () => ({
            set: (values: Record<string, unknown>) => {
              captured.push(values);
              return { where: () => Promise.resolve(undefined) };
            },
          }),
        };
        return await fn(tx);
      },
    );
    const service = makeService(withTenantTx);

    await service.markCompleted('tenant-a', 'job-1', {
      synced: 5,
      updated: 3,
      errors: 0,
    });

    const [set] = captured;
    expect(set.productsSynced).toBe(5);
    expect(set.productsUpdated).toBe(3);
    expect(set.productsFailed).toBe(0);
  });

  // Phase 6 review finding 5: a run stopped at StoreSyncService's page cap
  // finished, but not faithfully — the row must not read as a clean success.
  it('records a completion warning on the row, truncated like any other message', async () => {
    const captured: Record<string, unknown>[] = [];
    const withTenantTx: jest.Mock = jest.fn(
      async (fn: (tx: unknown) => unknown) => {
        const tx = {
          update: () => ({
            set: (values: Record<string, unknown>) => {
              captured.push(values);
              return { where: () => Promise.resolve(undefined) };
            },
          }),
        };
        return await fn(tx);
      },
    );
    const service = makeService(withTenantTx);

    await service.markCompleted('tenant-a', 'job-1', {
      synced: 5,
      updated: 2,
      errors: 0,
      warning: 'w'.repeat(5000),
    });
    await service.markCompleted('tenant-a', 'job-2', {
      synced: 5,
      updated: 2,
      errors: 0,
    });

    const [truncatedRun, cleanRun] = captured;
    expect(truncatedRun.status).toBe('completed');
    expect((truncatedRun.errorMessage as string).length).toBe(1000);
    // A clean run must not touch the column at all — a blank string would
    // read as "a message was recorded and lost".
    expect(cleanRun).not.toHaveProperty('errorMessage');
  });
});
