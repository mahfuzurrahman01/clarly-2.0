// F24 follow-up: the sweep's trigger mechanism moved from `setInterval` to a
// BullMQ repeatable job (`StoreSyncSchedulerService`). This pins the worker
// side: the processor still iterates every active connection and syncs each
// one, tolerating a single connection's failure without stopping the sweep.
//
// Clarly 2.0 RLS fix: `store_connections` is FORCE RLS, so the sweep lists
// tenants first and reads each tenant's active connections under that tenant.
import type { Job } from 'bullmq';
import type { AppLoggerService } from '../core';
import type { TenantDirectoryService } from '../tenant-context/tenant-directory';
import { StoreSyncProcessor } from './store-sync.processor';
import type {
  StoreConnection,
  StoreConnectionService,
} from './store-connection.service';
import type { StoreSyncService } from './store-sync.service';

function makeConnection(
  overrides: Partial<StoreConnection> = {},
): StoreConnection {
  return {
    id: 'conn-1',
    tenantId: 'tenant-a',
    provider: 'salla',
    storeId: 'store-1',
    storeName: 'Acme Store',
    storeUrl: null,
    accessToken: 'token',
    refreshToken: null,
    authorizationToken: null,
    tokenExpiresAt: null,
    webhookSecret: null,
    isActive: true,
    lastSyncedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeHarness(
  byTenant: Record<string, StoreConnection[]>,
  syncConnection: jest.Mock = jest
    .fn()
    .mockResolvedValue({ synced: 1, errors: 0 }),
) {
  const listTenantIds = jest.fn().mockResolvedValue(Object.keys(byTenant));
  const findActiveByTenant = jest.fn((tenantId: string) =>
    Promise.resolve(byTenant[tenantId] ?? []),
  );
  const logError = jest.fn();
  const logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: logError,
    debug: jest.fn(),
  } as unknown as AppLoggerService;
  const processor = new StoreSyncProcessor(
    { syncConnection } as unknown as StoreSyncService,
    { findActiveByTenant } as unknown as StoreConnectionService,
    { listTenantIds } as unknown as TenantDirectoryService,
    logger,
  );
  return {
    processor,
    listTenantIds,
    findActiveByTenant,
    syncConnection,
    logError,
  };
}

describe('StoreSyncProcessor', () => {
  it('syncs every active connection when the sweep job runs', async () => {
    const connections = [
      makeConnection({ id: 'conn-1' }),
      makeConnection({ id: 'conn-2' }),
    ];
    const { processor, listTenantIds, findActiveByTenant, syncConnection } =
      makeHarness({ 'tenant-a': connections });

    await processor.process({} as Job);

    expect(listTenantIds).toHaveBeenCalledTimes(1);
    expect(findActiveByTenant).toHaveBeenCalledTimes(1);
    expect(findActiveByTenant).toHaveBeenCalledWith('tenant-a');
    expect(syncConnection).toHaveBeenCalledTimes(2);
    expect(syncConnection).toHaveBeenCalledWith(connections[0]);
    expect(syncConnection).toHaveBeenCalledWith(connections[1]);
  });

  it('reads each tenant’s connections under that tenant', async () => {
    const a = makeConnection({ id: 'conn-a', tenantId: 'tenant-a' });
    const b = makeConnection({ id: 'conn-b', tenantId: 'tenant-b' });
    const { processor, listTenantIds, findActiveByTenant, syncConnection } =
      makeHarness({ 'tenant-a': [a], 'tenant-b': [b], 'tenant-c': [] });

    await processor.process({} as Job);

    // Customer-facing work: closed workspaces are not synced.
    expect(listTenantIds).toHaveBeenCalledWith();
    expect(findActiveByTenant.mock.calls.map((call) => call[0]).sort()).toEqual(
      ['tenant-a', 'tenant-b', 'tenant-c'],
    );
    expect(syncConnection).toHaveBeenCalledTimes(2);
    expect(syncConnection).toHaveBeenCalledWith(a);
    expect(syncConnection).toHaveBeenCalledWith(b);
  });

  it('does nothing when there are no active connections', async () => {
    const { processor, syncConnection } = makeHarness({ 'tenant-a': [] });

    await processor.process({} as Job);

    expect(syncConnection).not.toHaveBeenCalled();
  });

  it('does nothing when there are no tenants', async () => {
    const { processor, findActiveByTenant, syncConnection } = makeHarness({});

    await processor.process({} as Job);

    expect(findActiveByTenant).not.toHaveBeenCalled();
    expect(syncConnection).not.toHaveBeenCalled();
  });

  it('keeps syncing the rest when one connection fails', async () => {
    const connections = [
      makeConnection({ id: 'conn-1' }),
      makeConnection({ id: 'conn-2' }),
    ];
    const { processor, syncConnection, logError } = makeHarness(
      { 'tenant-a': connections },
      jest
        .fn()
        .mockRejectedValueOnce(new Error('provider down'))
        .mockResolvedValueOnce({ synced: 1, errors: 0 }),
    );

    await expect(processor.process({} as Job)).resolves.toBeUndefined();

    expect(syncConnection).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalled();
  });

  it('keeps syncing other tenants when one tenant’s read fails', async () => {
    const b = makeConnection({ id: 'conn-b', tenantId: 'tenant-b' });
    const { processor, findActiveByTenant, syncConnection } = makeHarness({
      'tenant-a': [],
      'tenant-b': [b],
    });
    findActiveByTenant.mockImplementation((tenantId: string) =>
      tenantId === 'tenant-a'
        ? Promise.reject(new Error('connection reset'))
        : Promise.resolve([b]),
    );

    await expect(processor.process({} as Job)).resolves.toBeUndefined();

    expect(syncConnection).toHaveBeenCalledTimes(1);
    expect(syncConnection).toHaveBeenCalledWith(b);
  });
});
