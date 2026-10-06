import type { PersistenceService } from '../persistence/persistence.service';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import type { TenantSubscriptionRecord } from './billing.dto';
import type { BillingService } from './billing.service';
import { UsageService, evaluateEntitlementGate } from './usage.service';

const TENANT_A = 'tenant-a';

function chain(
  resolveWith: unknown,
): Record<string, (...args: never[]) => unknown> {
  const node: Record<string, (...args: never[]) => unknown> = {
    from: () => node,
    where: () => node,
    limit: () => node,
    then: (onFulfilled: (value: unknown) => unknown): Promise<unknown> =>
      Promise.resolve(resolveWith).then(onFulfilled),
  };
  return node;
}

function makeHarness(): {
  service: UsageService;
  persistence: { runAdminQuery: jest.Mock };
  tenantContext: { withTenantTx: jest.Mock };
  billing: { getForTenant: jest.Mock };
} {
  const persistence = { runAdminQuery: jest.fn() };
  const tenantContext = { withTenantTx: jest.fn() };
  const billing = { getForTenant: jest.fn() };

  const service = new UsageService(
    persistence as unknown as PersistenceService,
    tenantContext as unknown as TenantContextService,
    billing as unknown as BillingService,
  );

  return { service, persistence, tenantContext, billing };
}

describe('UsageService.getMonthlyUsage()', () => {
  it('aggregates real usage rows for the given tenant', async () => {
    const { service, tenantContext } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(
      (fn: (tx: unknown) => unknown) =>
        fn({
          select: () =>
            chain([
              {
                messageCount: 42,
                inputTokens: 1000,
                outputTokens: 200,
                totalCostUsd: 0.5,
              },
            ]),
        }),
    );

    const usage = await service.getMonthlyUsage(TENANT_A);

    expect(usage).toMatchObject({
      tenantId: TENANT_A,
      messageCount: 42,
      inputTokens: 1000,
      outputTokens: 200,
      totalCostUsd: 0.5,
    });
  });

  it('defaults every field to 0 when there is no data at all for the period', async () => {
    const { service, tenantContext } = makeHarness();
    tenantContext.withTenantTx.mockImplementation(
      (fn: (tx: unknown) => unknown) => fn({ select: () => chain([]) }),
    );

    const usage = await service.getMonthlyUsage(TENANT_A);

    expect(usage).toMatchObject({
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
    });
  });
});

describe('evaluateEntitlementGate() — Lane A entitlement matrix', () => {
  function sub(
    overrides: Partial<
      Pick<TenantSubscriptionRecord, 'status' | 'trialEndsAt' | 'comped'>
    >,
  ): Pick<TenantSubscriptionRecord, 'status' | 'trialEndsAt' | 'comped'> {
    return {
      status: 'incomplete',
      trialEndsAt: null,
      comped: false,
      ...overrides,
    };
  }

  it('blocks with no_subscription when there is no row at all', () => {
    expect(evaluateEntitlementGate(null)).toEqual({
      allowed: false,
      blockReason: 'no_subscription',
    });
  });

  it('always allows a comped tenant, regardless of status', () => {
    for (const status of [
      'incomplete',
      'trialing',
      'active',
      'past_due',
      'canceled',
    ] as const) {
      expect(evaluateEntitlementGate(sub({ status, comped: true }))).toEqual({
        allowed: true,
        blockReason: null,
      });
    }
  });

  it('allows active', () => {
    expect(evaluateEntitlementGate(sub({ status: 'active' }))).toEqual({
      allowed: true,
      blockReason: null,
    });
  });

  it('allows trialing while trialEndsAt is in the future', () => {
    expect(
      evaluateEntitlementGate(
        sub({ status: 'trialing', trialEndsAt: new Date(Date.now() + 60_000) }),
      ),
    ).toEqual({ allowed: true, blockReason: null });
  });

  it('blocks with trial_expired when trialing but trialEndsAt has passed', () => {
    expect(
      evaluateEntitlementGate(
        sub({ status: 'trialing', trialEndsAt: new Date(Date.now() - 60_000) }),
      ),
    ).toEqual({ allowed: false, blockReason: 'trial_expired' });
  });

  it('blocks with trial_expired when trialing but trialEndsAt is null', () => {
    expect(
      evaluateEntitlementGate(sub({ status: 'trialing', trialEndsAt: null })),
    ).toEqual({ allowed: false, blockReason: 'trial_expired' });
  });

  it('blocks with past_due', () => {
    expect(evaluateEntitlementGate(sub({ status: 'past_due' }))).toEqual({
      allowed: false,
      blockReason: 'past_due',
    });
  });

  it('blocks with canceled', () => {
    expect(evaluateEntitlementGate(sub({ status: 'canceled' }))).toEqual({
      allowed: false,
      blockReason: 'canceled',
    });
  });

  it('blocks with incomplete', () => {
    expect(evaluateEntitlementGate(sub({ status: 'incomplete' }))).toEqual({
      allowed: false,
      blockReason: 'incomplete',
    });
  });

  it('fails closed (blockReason: incomplete) for an unrecognized future status', () => {
    expect(
      evaluateEntitlementGate(sub({ status: 'some_future_status' as never })),
    ).toEqual({ allowed: false, blockReason: 'incomplete' });
  });
});

describe('UsageService.checkEntitlement()', () => {
  it('blocks with no_subscription when the tenant has no subscription at all', async () => {
    const { service, billing } = makeHarness();
    billing.getForTenant.mockResolvedValue(null);

    const result = await service.checkEntitlement(TENANT_A);

    expect(result).toEqual({
      allowed: false,
      blockReason: 'no_subscription',
      hasEnforceablePlan: false,
      overMessageLimit: false,
      overSpendCap: false,
      usage: null,
    });
  });

  it('blocks (past_due) and reports hasEnforceablePlan: false when the subscription is past_due (not active/trialing)', async () => {
    const { service, billing } = makeHarness();
    billing.getForTenant.mockResolvedValue({
      planId: 'plan-1',
      status: 'past_due',
      trialEndsAt: null,
      comped: false,
    });

    const result = await service.checkEntitlement(TENANT_A);

    expect(result.allowed).toBe(false);
    expect(result.blockReason).toBe('past_due');
    expect(result.hasEnforceablePlan).toBe(false);
  });

  it('always allows a comped tenant, even one with no real Stripe subscription', async () => {
    const { service, billing } = makeHarness();
    billing.getForTenant.mockResolvedValue({
      planId: 'plan-1',
      status: 'incomplete',
      trialEndsAt: null,
      comped: true,
    });

    const result = await service.checkEntitlement(TENANT_A);

    expect(result.allowed).toBe(true);
    expect(result.blockReason).toBeNull();
    expect(result.hasEnforceablePlan).toBe(false);
  });

  it('reports overMessageLimit/overSpendCap correctly when usage meets or exceeds the plan caps', async () => {
    const { service, billing, persistence, tenantContext } = makeHarness();
    billing.getForTenant.mockResolvedValue({
      planId: 'plan-1',
      status: 'active',
      trialEndsAt: null,
      comped: false,
    });
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({
          select: () =>
            chain([
              {
                id: 'plan-1',
                monthlyMessageLimit: 100,
                monthlySpendCapUsd: 10,
              },
            ]),
        }),
    );
    tenantContext.withTenantTx.mockImplementation(
      (fn: (tx: unknown) => unknown) =>
        fn({
          select: () =>
            chain([
              {
                messageCount: 100,
                inputTokens: 0,
                outputTokens: 0,
                totalCostUsd: 10,
              },
            ]),
        }),
    );

    const result = await service.checkEntitlement(TENANT_A);

    expect(result).toMatchObject({
      hasEnforceablePlan: true,
      overMessageLimit: true,
      overSpendCap: true,
    });
  });

  it('reports both false when usage is comfortably under both caps', async () => {
    const { service, billing, persistence, tenantContext } = makeHarness();
    billing.getForTenant.mockResolvedValue({
      planId: 'plan-1',
      status: 'trialing',
      trialEndsAt: new Date(Date.now() + 60_000),
      comped: false,
    });
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({
          select: () =>
            chain([
              {
                id: 'plan-1',
                monthlyMessageLimit: 1000,
                monthlySpendCapUsd: 50,
              },
            ]),
        }),
    );
    tenantContext.withTenantTx.mockImplementation(
      (fn: (tx: unknown) => unknown) =>
        fn({
          select: () =>
            chain([
              {
                messageCount: 5,
                inputTokens: 0,
                outputTokens: 0,
                totalCostUsd: 0.1,
              },
            ]),
        }),
    );

    const result = await service.checkEntitlement(TENANT_A);

    expect(result).toMatchObject({
      hasEnforceablePlan: true,
      overMessageLimit: false,
      overSpendCap: false,
    });
  });

  it('reports hasEnforceablePlan: false when the subscription references a plan that no longer exists', async () => {
    const { service, billing, persistence } = makeHarness();
    billing.getForTenant.mockResolvedValue({
      planId: 'deleted-plan',
      status: 'active',
      trialEndsAt: null,
      comped: false,
    });
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) => fn({ select: () => chain([]) }),
    );

    const result = await service.checkEntitlement(TENANT_A);

    expect(result.hasEnforceablePlan).toBe(false);
  });
});
