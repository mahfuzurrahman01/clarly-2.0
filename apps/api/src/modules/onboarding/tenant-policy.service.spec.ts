import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { TenantPolicyService } from './tenant-policy.service';

const TENANT_A = 'tenant-a';

/**
 * Calls through to the real withTenantTx() callback against a fake `tx`
 * matching TenantPolicyService's exact chain (select/where/limit,
 * insert/values/onConflictDoUpdate/returning) — see the identical rationale
 * in kb-document.service.spec.ts: a mock that never invokes the callback
 * leaves the actual query-building logic (and its branches) untested.
 */
function makeTenantContext(rowsToReturn: unknown[][]): {
  tenantContext: TenantContextService;
  withTenantTx: jest.Mock;
} {
  let call = 0;
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const rows = rowsToReturn[call++] ?? [];
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve(rows),
          }),
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

describe('TenantPolicyService.getForTenant()', () => {
  it('returns null when no policy row exists yet', async () => {
    const { tenantContext } = makeTenantContext([[]]);
    const service = new TenantPolicyService(tenantContext);

    await expect(service.getForTenant(TENANT_A)).resolves.toBeNull();
  });

  it('maps a found row to TenantPolicyRecord', async () => {
    const row = {
      tenantId: TENANT_A,
      confidenceThreshold: 0.7,
      forbiddenTopics: ['pricing'],
      tonePersonaOverride: null,
    };
    const { tenantContext } = makeTenantContext([[row]]);
    const service = new TenantPolicyService(tenantContext);

    await expect(service.getForTenant(TENANT_A)).resolves.toEqual(row);
  });
});

describe('TenantPolicyService.upsert()', () => {
  it('seeds a first-time policy row scoped to the tenant, no fields provided', async () => {
    const seededRow = {
      tenantId: TENANT_A,
      confidenceThreshold: 0.7,
      forbiddenTopics: [],
      tonePersonaOverride: null,
    };
    const { tenantContext, withTenantTx } = makeTenantContext([
      [],
      [seededRow],
    ]);
    const service = new TenantPolicyService(tenantContext);

    const result = await service.upsert(TENANT_A, {});

    expect(result).toEqual(seededRow);
    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
  });

  it('overrides only the fields provided, keeping prior values for the rest', async () => {
    const existing = {
      tenantId: TENANT_A,
      confidenceThreshold: 0.7,
      forbiddenTopics: ['pricing'],
      tonePersonaOverride: 'friendly',
    };
    const updated = { ...existing, confidenceThreshold: 0.85 };
    const { tenantContext } = makeTenantContext([[existing], [updated]]);
    const service = new TenantPolicyService(tenantContext);

    const result = await service.upsert(TENANT_A, {
      confidenceThreshold: 0.85,
    });

    expect(result.confidenceThreshold).toBe(0.85);
    expect(result.forbiddenTopics).toEqual(['pricing']);
    expect(result.tonePersonaOverride).toBe('friendly');
  });

  it('provides forbiddenTopics explicitly, exercising the "input value provided" branch', async () => {
    const existing = {
      tenantId: TENANT_A,
      confidenceThreshold: 0.7,
      forbiddenTopics: [],
      tonePersonaOverride: null,
    };
    const updated = { ...existing, forbiddenTopics: ['refunds'] };
    const { tenantContext } = makeTenantContext([[existing], [updated]]);
    const service = new TenantPolicyService(tenantContext);

    const result = await service.upsert(TENANT_A, {
      forbiddenTopics: ['refunds'],
    });

    expect(result.forbiddenTopics).toEqual(['refunds']);
  });

  it('explicitly clearing tonePersonaOverride to null overrides the prior value', async () => {
    const existing = {
      tenantId: TENANT_A,
      confidenceThreshold: 0.7,
      forbiddenTopics: [],
      tonePersonaOverride: 'friendly',
    };
    const updated = { ...existing, tonePersonaOverride: null };
    const { tenantContext } = makeTenantContext([[existing], [updated]]);
    const service = new TenantPolicyService(tenantContext);

    const result = await service.upsert(TENANT_A, {
      tonePersonaOverride: null,
    });

    expect(result.tonePersonaOverride).toBeNull();
  });

  it('when no prior row exists and tonePersonaOverride is omitted, falls back to null', async () => {
    const seededRow = {
      tenantId: TENANT_A,
      confidenceThreshold: 0.7,
      forbiddenTopics: [],
      tonePersonaOverride: null,
    };
    const { tenantContext } = makeTenantContext([[], [seededRow]]);
    const service = new TenantPolicyService(tenantContext);

    const result = await service.upsert(TENANT_A, { confidenceThreshold: 0.9 });

    expect(result.tonePersonaOverride).toBeNull();
  });
});
