import type { PersistenceService } from '../persistence/persistence.service';
import {
  TENANT_STATUS_TTL_MS,
  TenantStatusService,
} from './tenant-status.service';

const TENANT = 'tenant-a';

function chain(resolveWith: unknown): Record<string, unknown> {
  const node: Record<string, unknown> = {
    from: () => node,
    where: () => node,
    limit: () => node,
    then: (onFulfilled: (value: unknown) => unknown): Promise<unknown> =>
      Promise.resolve(resolveWith).then(onFulfilled),
  };
  return node;
}

function makeHarness(rows: unknown[]) {
  const runAdminQuery = jest.fn((fn: (db: unknown) => unknown) =>
    fn({ select: () => chain(rows) }),
  );
  return {
    service: new TenantStatusService({
      runAdminQuery,
    } as unknown as PersistenceService),
    runAdminQuery,
  };
}

describe('TenantStatusService.isClosed()', () => {
  it('reports an open tenant as open', async () => {
    const { service } = makeHarness([{ closedAt: null }]);

    await expect(service.isClosed(TENANT)).resolves.toBe(false);
  });

  it('reports a closed tenant as closed', async () => {
    const { service } = makeHarness([{ closedAt: new Date() }]);

    await expect(service.isClosed(TENANT)).resolves.toBe(true);
  });

  // The row is gone because the purge already ran. A token still carrying that
  // tenant id must not be honoured — fail closed.
  it('treats a tenant that no longer exists as closed', async () => {
    const { service } = makeHarness([]);

    await expect(service.isClosed(TENANT)).resolves.toBe(true);
  });

  // This is the entire reason the service exists: the middleware calls it on
  // every authenticated request, and it must not be a query each time.
  it('hits the database once across repeated calls inside the TTL', async () => {
    const { service, runAdminQuery } = makeHarness([{ closedAt: null }]);

    await service.isClosed(TENANT, 1_000);
    await service.isClosed(TENANT, 2_000);
    await service.isClosed(TENANT, 3_000);

    expect(runAdminQuery).toHaveBeenCalledTimes(1);
  });

  it('re-reads once the TTL has passed', async () => {
    const { service, runAdminQuery } = makeHarness([{ closedAt: null }]);

    await service.isClosed(TENANT, 1_000);
    await service.isClosed(TENANT, 1_000 + TENANT_STATUS_TTL_MS + 1);

    expect(runAdminQuery).toHaveBeenCalledTimes(2);
  });

  it('caches per tenant, not globally', async () => {
    const { service, runAdminQuery } = makeHarness([{ closedAt: null }]);

    await service.isClosed('tenant-a', 1_000);
    await service.isClosed('tenant-b', 1_000);

    expect(runAdminQuery).toHaveBeenCalledTimes(2);
  });

  // So the admin who just closed or reopened sees it take effect at once,
  // rather than waiting out a TTL on their own action.
  it('re-reads immediately after invalidate()', async () => {
    const { service, runAdminQuery } = makeHarness([{ closedAt: null }]);

    await service.isClosed(TENANT, 1_000);
    service.invalidate(TENANT);
    await service.isClosed(TENANT, 1_001);

    expect(runAdminQuery).toHaveBeenCalledTimes(2);
  });
});
