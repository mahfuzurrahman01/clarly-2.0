// F24: the sync path now records what it did. Before this, a store that had
// failed every sync for a week was indistinguishable from one that had never
// synced at all, because nothing ever wrote a `store_sync_jobs` row.
import type { AppLoggerService } from '../core';
import type { AppConfigService } from '../core/config/app-config.service';
import type { CatalogService } from '../catalog/catalog.service';
import { MAX_PRODUCT_SYNC_PAGES, StoreSyncService } from './store-sync.service';
import type {
  StoreConnection,
  StoreConnectionService,
} from './store-connection.service';
import type { StoreOAuthService } from './store-oauth.service';
import type { StoreProviderRegistry } from './store-provider.registry';
import type { StoreSyncJobService } from './store-sync-job.service';
import type { StoreProduct, StoreProvider } from './ports/store-provider.port';

function makeLogger(): AppLoggerService {
  return {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLoggerService;
}

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

function makeProduct(externalId: string): StoreProduct {
  return {
    externalId,
    name: `Product ${externalId}`,
    price: 100,
    currency: 'SAR',
    stock: 5,
    stockStatus: 'in_stock',
    metadata: {},
  };
}

function makeHarness(options: {
  listProducts?: jest.Mock;
  upsertProductDetailed?: jest.Mock;
  jobId?: string | null;
  authorizationToken?: string;
}) {
  const listProducts =
    options.listProducts ??
    jest.fn().mockResolvedValue({
      products: [makeProduct('P-1'), makeProduct('P-2')],
      hasNextPage: false,
    });
  const adapter = { listProducts } as unknown as StoreProvider;

  const markSynced = jest.fn().mockResolvedValue(undefined);
  const connectionService = {
    markSynced,
    findActiveByTenant: jest.fn().mockResolvedValue([makeConnection()]),
  } as unknown as StoreConnectionService;
  const oauthService = {
    ensureCredentials: jest.fn().mockResolvedValue({
      accessToken: 'fresh-token',
      authorizationToken: options.authorizationToken,
    }),
  } as unknown as StoreOAuthService;
  const upsertProductDetailed =
    options.upsertProductDetailed ??
    jest.fn().mockResolvedValue({ product: {}, created: true });
  const catalogService = {
    upsertProductDetailed,
  } as unknown as CatalogService;
  const registry = {
    forProvider: jest.fn().mockReturnValue(adapter),
  } as unknown as StoreProviderRegistry;

  const jobs = {
    enqueue: jest
      .fn()
      .mockResolvedValue(options.jobId === undefined ? 'job-1' : options.jobId),
    markRunning: jest.fn().mockResolvedValue(undefined),
    markCompleted: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  };

  const service = new StoreSyncService(
    connectionService,
    oauthService,
    catalogService,
    registry,
    jobs as unknown as StoreSyncJobService,
    { storeSyncIntervalMs: 900_000 } as unknown as AppConfigService,
    makeLogger(),
  );

  return { service, jobs, listProducts, upsertProductDetailed, markSynced };
}

describe('StoreSyncService — adapter credentials', () => {
  it("passes the store id and Zid's partner token from the same credential read", async () => {
    const { service, listProducts } = makeHarness({
      authorizationToken: 'partner-token',
    });

    await service.syncConnection(makeConnection());

    expect(listProducts).toHaveBeenCalledWith('fresh-token', undefined, {
      shop: 'store-1',
      authorizationToken: 'partner-token',
    });
  });
});

describe('StoreSyncService — job recording', () => {
  it('records queued → running → completed with the real counts', async () => {
    const { service, jobs } = makeHarness({});

    const result = await service.syncConnection(makeConnection());

    expect(jobs.enqueue).toHaveBeenCalledWith(
      'tenant-a',
      'conn-1',
      'product_sync',
    );
    expect(jobs.markRunning).toHaveBeenCalledWith('tenant-a', 'job-1');
    expect(jobs.markCompleted).toHaveBeenCalledWith('tenant-a', 'job-1', {
      synced: 2,
      updated: 0,
      errors: 0,
    });
    expect(jobs.markFailed).not.toHaveBeenCalled();
    expect(result).toEqual({ synced: 2, errors: 0 });
  });

  it('splits the completed count into created vs updated from CatalogService', async () => {
    const upsertProductDetailed = jest
      .fn()
      .mockResolvedValueOnce({ product: {}, created: true })
      .mockResolvedValueOnce({ product: {}, created: false });
    const { service, jobs } = makeHarness({ upsertProductDetailed });

    await service.syncConnection(makeConnection());

    expect(jobs.markCompleted).toHaveBeenCalledWith('tenant-a', 'job-1', {
      synced: 2,
      updated: 1,
      errors: 0,
    });
  });

  it('records a failure with the provider’s message, not a silent zero-sync', async () => {
    const { service, jobs } = makeHarness({
      listProducts: jest
        .fn()
        .mockRejectedValue(new Error('Salla products list failed: 503')),
    });

    const result = await service.syncConnection(makeConnection());

    expect(jobs.markCompleted).not.toHaveBeenCalled();
    expect(jobs.markFailed).toHaveBeenCalledWith(
      'tenant-a',
      'job-1',
      'Salla products list failed: 503',
      { synced: 0, errors: 1 },
    );
    expect(result).toEqual({ synced: 0, errors: 1 });
  });

  it('counts per-product failures into the completed row rather than failing the run', async () => {
    const { service, jobs } = makeHarness({
      upsertProductDetailed: jest
        .fn()
        .mockResolvedValueOnce({ product: {}, created: true })
        .mockRejectedValueOnce(new Error('catalog write failed')),
    });

    await service.syncConnection(makeConnection());

    expect(jobs.markCompleted).toHaveBeenCalledWith('tenant-a', 'job-1', {
      synced: 1,
      updated: 0,
      errors: 1,
    });
  });

  it('still syncs when the job row could not be written (bookkeeping is best-effort)', async () => {
    const { service, jobs, upsertProductDetailed } = makeHarness({
      jobId: null,
    });

    const result = await service.syncConnection(makeConnection());

    expect(upsertProductDetailed).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ synced: 2, errors: 0 });
    expect(jobs.markRunning).not.toHaveBeenCalled();
    expect(jobs.markCompleted).not.toHaveBeenCalled();
  });

  it('records no job at all for an inactive connection — nothing was attempted', async () => {
    const { service, jobs } = makeHarness({});

    const result = await service.syncConnection(
      makeConnection({ isActive: false }),
    );

    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(result).toEqual({ synced: 0, errors: 0 });
  });

  it('marks the connection synced on success', async () => {
    const { service, markSynced } = makeHarness({});
    await service.syncConnection(makeConnection());
    expect(markSynced).toHaveBeenCalledWith('tenant-a', 'conn-1');
  });

  // Phase 6 review finding 5: the loop's exit condition comes from the store,
  // and with WooCommerce that store is a host the merchant controls. A site
  // that always reports another page would otherwise pin the sweep forever.
  it('stops at the page cap when the store never stops reporting another page', async () => {
    const listProducts = jest.fn().mockResolvedValue({
      products: [makeProduct('P-1')],
      hasNextPage: true,
      nextCursor: 'next',
    });
    const { service, jobs } = makeHarness({ listProducts });

    const result = await service.syncConnection(makeConnection());

    expect(listProducts).toHaveBeenCalledTimes(MAX_PRODUCT_SYNC_PAGES);
    expect(result).toEqual({ synced: MAX_PRODUCT_SYNC_PAGES, errors: 0 });
    // Completed, but explicitly not a clean success: the local catalogue is
    // only a prefix of the store's.
    const [, , completed] = jobs.markCompleted.mock.calls[0] as [
      string,
      string,
      { synced: number; updated: number; errors: number; warning?: string },
    ];
    expect(completed.warning).toContain(String(MAX_PRODUCT_SYNC_PAGES));
  });

  it('records no warning on a run that walked every page the store had', async () => {
    const { service, jobs } = makeHarness({});

    await service.syncConnection(makeConnection());

    expect(jobs.markCompleted).toHaveBeenCalledWith('tenant-a', 'job-1', {
      synced: 2,
      updated: 0,
      errors: 0,
    });
  });

  it('aggregates every connection when syncing a whole tenant', async () => {
    const { service } = makeHarness({});
    await expect(service.syncAllForTenant('tenant-a')).resolves.toEqual({
      synced: 2,
      errors: 0,
    });
  });
});
