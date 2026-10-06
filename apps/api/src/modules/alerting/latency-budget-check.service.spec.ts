import type { AppConfigService, AppLoggerService } from '../core';
import type { PersistenceService } from '../persistence/persistence.service';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { LatencyBudgetAlertEventsService } from './latency-budget-alert-events.service';
import { LatencyBudgetCheckService } from './latency-budget-check.service';

function makeLogger(): AppLoggerService {
  return { warn: jest.fn() } as unknown as AppLoggerService;
}

function makeConfig(): AppConfigService {
  return {
    latencyCheckWindowMinutes: 15,
    latencyP95BudgetMs: 5000,
  } as AppConfigService;
}

function makeHarness(): {
  service: LatencyBudgetCheckService;
  persistence: { runAdminQuery: jest.Mock };
  tenantContext: { withTenantTx: jest.Mock };
  alertEvents: { fire: jest.Mock };
} {
  const persistence = { runAdminQuery: jest.fn() };
  const withTenantTx = jest.fn();
  const tenantContext = { withTenantTx };
  const alertEvents = { fire: jest.fn() };

  const service = new LatencyBudgetCheckService(
    persistence as unknown as PersistenceService,
    tenantContext as unknown as TenantContextService,
    alertEvents as unknown as LatencyBudgetAlertEventsService,
    makeConfig(),
    makeLogger(),
  );

  return { service, persistence, tenantContext, alertEvents };
}

function stubTenantList(
  persistence: { runAdminQuery: jest.Mock },
  ids: string[],
) {
  persistence.runAdminQuery.mockImplementation((fn: (db: unknown) => unknown) =>
    fn({
      select: () => ({
        from: () => Promise.resolve(ids.map((id) => ({ id }))),
      }),
    }),
  );
}

function stubP95(
  tenantContext: { withTenantTx: jest.Mock },
  rows: Record<string, Array<{ p95: number | null; sampleSize: number }>>,
) {
  tenantContext.withTenantTx.mockImplementation(
    (fn: (tx: unknown) => unknown, tenantId: string) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve(rows[tenantId] ?? []),
          }),
        }),
      }),
  );
}

describe('LatencyBudgetCheckService.checkAllTenants()', () => {
  it('fires an alert when p95 exceeds the budget with enough samples', async () => {
    const { service, persistence, tenantContext, alertEvents } = makeHarness();
    stubTenantList(persistence, ['tenant-a']);
    stubP95(tenantContext, {
      'tenant-a': [{ p95: 7500, sampleSize: 20 }],
    });

    const alerts = await service.checkAllTenants();

    expect(alerts).toEqual([
      {
        tenantId: 'tenant-a',
        p95LatencyMs: 7500,
        budgetMs: 5000,
        windowMinutes: 15,
        sampleSize: 20,
      },
    ]);
    expect(alertEvents.fire).toHaveBeenCalledWith(alerts[0]);
  });

  it('does not alert when p95 is within budget', async () => {
    const { service, persistence, tenantContext, alertEvents } = makeHarness();
    stubTenantList(persistence, ['tenant-a']);
    stubP95(tenantContext, {
      'tenant-a': [{ p95: 3000, sampleSize: 20 }],
    });

    const alerts = await service.checkAllTenants();

    expect(alerts).toEqual([]);
    expect(alertEvents.fire).not.toHaveBeenCalled();
  });

  it('does not alert when the sample size is too small, even if p95 looks bad', async () => {
    const { service, persistence, tenantContext, alertEvents } = makeHarness();
    stubTenantList(persistence, ['tenant-a']);
    stubP95(tenantContext, {
      'tenant-a': [{ p95: 9000, sampleSize: 3 }],
    });

    const alerts = await service.checkAllTenants();

    expect(alerts).toEqual([]);
    expect(alertEvents.fire).not.toHaveBeenCalled();
  });

  it('does not alert when there is no data at all for the window', async () => {
    const { service, persistence, tenantContext, alertEvents } = makeHarness();
    stubTenantList(persistence, ['tenant-a']);
    stubP95(tenantContext, {
      'tenant-a': [{ p95: null, sampleSize: 0 }],
    });

    const alerts = await service.checkAllTenants();

    expect(alerts).toEqual([]);
    expect(alertEvents.fire).not.toHaveBeenCalled();
  });

  it('sweeps every tenant independently', async () => {
    const { service, persistence, tenantContext } = makeHarness();
    stubTenantList(persistence, ['tenant-a', 'tenant-b']);
    stubP95(tenantContext, {
      'tenant-a': [{ p95: 8000, sampleSize: 20 }],
      'tenant-b': [{ p95: 1000, sampleSize: 20 }],
    });

    const alerts = await service.checkAllTenants();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].tenantId).toBe('tenant-a');
  });
});
