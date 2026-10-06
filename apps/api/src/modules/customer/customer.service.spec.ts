import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { CustomerService } from './customer.service';

const TENANT_A = 'tenant-a';

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'customer-1',
    tenantId: TENANT_A,
    phone: '15551234567',
    name: null,
    tags: [],
    notes: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Calls through to the real withTenantTx() callback against a fake tx matching CustomerService's exact chains — same rationale used throughout this codebase (F2.5/A1/A7/etc specs): a mock that never invokes the callback leaves the actual query logic untested. */
function makeTenantContext(responses: unknown[]): {
  tenantContext: TenantContextService;
  withTenantTx: jest.Mock;
} {
  let call = 0;
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const response = responses[call++];
    const tx = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve(response),
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({ returning: () => Promise.resolve(response) }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve(response) }),
        }),
      }),
    };
    return fn(tx);
  });
  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    withTenantTx,
  };
}

describe('CustomerService.getOrCreateByPhone()', () => {
  it('upserts and returns the customer record', async () => {
    const row = makeRow();
    const { tenantContext } = makeTenantContext([[row]]);
    const service = new CustomerService(tenantContext);

    const result = await service.getOrCreateByPhone(TENANT_A, '15551234567');

    expect(result).toEqual({
      id: 'customer-1',
      tenantId: TENANT_A,
      phone: '15551234567',
      name: null,
      tags: [],
      notes: null,
    });
  });

  it('scopes the upsert to the tenant via withTenantTx()', async () => {
    const row = makeRow();
    const { tenantContext, withTenantTx } = makeTenantContext([[row]]);
    const service = new CustomerService(tenantContext);

    await service.getOrCreateByPhone(TENANT_A, '15551234567');

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
  });
});

describe('CustomerService.getCustomer()', () => {
  it('returns null when no customer exists', async () => {
    const { tenantContext } = makeTenantContext([[]]);
    const service = new CustomerService(tenantContext);

    await expect(
      service.getCustomer(TENANT_A, 'customer-1'),
    ).resolves.toBeNull();
  });

  it('maps a found row to CustomerRecord', async () => {
    const row = makeRow({
      name: 'Jane',
      tags: ['vip'],
      notes: 'prefers email',
    });
    const { tenantContext } = makeTenantContext([[row]]);
    const service = new CustomerService(tenantContext);

    const result = await service.getCustomer(TENANT_A, 'customer-1');

    expect(result?.name).toBe('Jane');
    expect(result?.tags).toEqual(['vip']);
    expect(result?.notes).toBe('prefers email');
  });
});

describe('CustomerService.updateCustomer()', () => {
  it('updates only the fields provided', async () => {
    const row = makeRow({ name: 'Updated Name' });
    const { tenantContext, withTenantTx } = makeTenantContext([[row]]);
    const service = new CustomerService(tenantContext);

    const result = await service.updateCustomer(TENANT_A, 'customer-1', {
      name: 'Updated Name',
    });

    expect(result?.name).toBe('Updated Name');
    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
  });

  // Prevents a 500 on an id that does not exist (or belongs to another
  // tenant, which RLS filters to the same empty result). Without the guard
  // the empty `returning()` destructures to undefined and mapping it throws
  // a TypeError, so the caller cannot tell "not found" from "server broke".
  it('returns null instead of throwing when no row matches', async () => {
    const { tenantContext } = makeTenantContext([[]]);
    const service = new CustomerService(tenantContext);

    await expect(
      service.updateCustomer(TENANT_A, 'does-not-exist', { name: 'Nope' }),
    ).resolves.toBeNull();
  });
});
