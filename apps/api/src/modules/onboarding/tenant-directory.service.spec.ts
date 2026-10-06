import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { TenantDirectoryService } from './tenant-directory.service';

const TENANT_A = '11111111-1111-4111-8111-111111111111';

/** Calls through to the real withTenantTx() callback against a fake tx matching TenantDirectoryService's exact chain, and records the where() argument so the tenant predicate can be asserted rather than assumed. */
function makeTenantContext(rows: unknown[]): {
  tenantContext: TenantContextService;
  withTenantTx: jest.Mock;
  whereArgs: unknown[];
} {
  const whereArgs: unknown[] = [];
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const tx = {
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            whereArgs.push(condition);
            return { limit: () => Promise.resolve(rows) };
          },
        }),
      }),
    };
    return fn(tx);
  });
  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    withTenantTx,
    whereArgs,
  };
}

describe('TenantDirectoryService.getById()', () => {
  it('returns the tenant id and name', async () => {
    const { tenantContext } = makeTenantContext([
      { id: TENANT_A, name: 'Acme Support' },
    ]);
    const service = new TenantDirectoryService(tenantContext);

    await expect(service.getById(TENANT_A)).resolves.toEqual({
      id: TENANT_A,
      name: 'Acme Support',
    });
  });

  // A tenant id that verified on the JWT but whose row is gone is a stale
  // session, not a server fault — the caller needs to tell those apart.
  it('returns null when the tenant row no longer exists', async () => {
    const { tenantContext } = makeTenantContext([]);
    const service = new TenantDirectoryService(tenantContext);

    await expect(service.getById(TENANT_A)).resolves.toBeNull();
  });

  // `tenants` has no RLS policy, so this predicate is the ONLY thing keeping
  // the query from returning every tenant on the platform. Nothing in
  // Postgres will catch its removal — this test is the backstop.
  it('always applies a where() predicate — the table has no RLS to fall back on', async () => {
    const { tenantContext, whereArgs } = makeTenantContext([
      { id: TENANT_A, name: 'Acme Support' },
    ]);
    const service = new TenantDirectoryService(tenantContext);

    await service.getById(TENANT_A);

    expect(whereArgs).toHaveLength(1);
    expect(whereArgs[0]).toBeDefined();
  });

  it('opens the transaction bound to the requested tenant', async () => {
    const { tenantContext, withTenantTx } = makeTenantContext([
      { id: TENANT_A, name: 'Acme Support' },
    ]);
    const service = new TenantDirectoryService(tenantContext);

    await service.getById(TENANT_A);

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
  });
});

describe('TenantDirectoryService.updateProfile()', () => {
  function makeUpdateContext(rows: unknown[]): {
    tenantContext: TenantContextService;
    withTenantTx: jest.Mock;
    whereArgs: unknown[];
    setArgs: unknown[];
  } {
    const whereArgs: unknown[] = [];
    const setArgs: unknown[] = [];
    const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
      fn({
        update: () => ({
          set: (values: unknown) => {
            setArgs.push(values);
            return {
              where: (condition: unknown) => {
                whereArgs.push(condition);
                return { returning: () => Promise.resolve(rows) };
              },
            };
          },
        }),
      }),
    );
    return {
      tenantContext: { withTenantTx } as unknown as TenantContextService,
      withTenantTx,
      whereArgs,
      setArgs,
    };
  }

  const ROW = {
    id: TENANT_A,
    name: 'Acme',
    vertical: 'services',
    country: 'SA',
    currency: 'SAR',
    defaultLocale: 'ar',
  };

  it('writes only the fields sent and returns the updated profile', async () => {
    const { tenantContext, setArgs } = makeUpdateContext([ROW]);
    const service = new TenantDirectoryService(tenantContext);

    await expect(
      service.updateProfile(TENANT_A, { vertical: 'services' }),
    ).resolves.toEqual(ROW);
    expect(setArgs).toEqual([{ vertical: 'services' }]);
  });

  // No RLS on `tenants`: without this predicate one admin's PATCH would
  // rewrite every workspace on the platform.
  it('always scopes the UPDATE with a where() predicate', async () => {
    const { tenantContext, whereArgs, withTenantTx } = makeUpdateContext([ROW]);
    const service = new TenantDirectoryService(tenantContext);

    await service.updateProfile(TENANT_A, { name: 'Acme' });

    expect(whereArgs).toHaveLength(1);
    expect(whereArgs[0]).toBeDefined();
    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
  });

  it('returns null when the tenant row is gone', async () => {
    const { tenantContext } = makeUpdateContext([]);
    const service = new TenantDirectoryService(tenantContext);
    await expect(
      service.updateProfile(TENANT_A, { name: 'Acme' }),
    ).resolves.toBeNull();
  });
});
