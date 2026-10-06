import type { AppConfigService, AppLoggerService } from '../core';
import type { PersistenceService } from '../persistence/persistence.service';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { AlertDebouncer } from './alert-debouncer';
import { ToolScopeViolationAlertEventsService } from './tool-scope-violation-alert-events.service';
import { ToolScopeViolationCheckService } from './tool-scope-violation-check.service';

function makeConfig(): AppConfigService {
  return {
    toolScopeViolationCheckWindowMinutes: 5,
    toolScopeViolationAlertThreshold: 3,
  } as AppConfigService;
}

function makeLogger(): { warn: jest.Mock } {
  return { warn: jest.fn() };
}

function makeHarness(): {
  service: ToolScopeViolationCheckService;
  persistence: { runAdminQuery: jest.Mock };
  tenantContext: { withTenantTx: jest.Mock };
  alertEvents: { fire: jest.Mock };
  logger: { warn: jest.Mock };
} {
  const persistence = { runAdminQuery: jest.fn() };
  const withTenantTx = jest.fn();
  const tenantContext = { withTenantTx };
  const alertEvents = { fire: jest.fn() };
  const logger = makeLogger();

  const service = new ToolScopeViolationCheckService(
    persistence as unknown as PersistenceService,
    tenantContext as unknown as TenantContextService,
    new AlertDebouncer(),
    alertEvents as unknown as ToolScopeViolationAlertEventsService,
    makeConfig(),
    logger as unknown as AppLoggerService,
  );

  return { service, persistence, tenantContext, alertEvents, logger };
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

function stubViolationCounts(
  tenantContext: { withTenantTx: jest.Mock },
  counts: Record<string, number>,
) {
  tenantContext.withTenantTx.mockImplementation(
    (fn: (tx: unknown) => unknown, tenantId: string) =>
      fn({
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([{ count: counts[tenantId] ?? 0 }]),
          }),
        }),
      }),
  );
}

describe('ToolScopeViolationCheckService.checkAllTenants()', () => {
  it('fires an alert when a tenant is at/over the threshold', async () => {
    const { service, persistence, tenantContext, alertEvents } = makeHarness();
    stubTenantList(persistence, ['tenant-a']);
    stubViolationCounts(tenantContext, { 'tenant-a': 5 });

    const alerts = await service.checkAllTenants();

    expect(alerts).toEqual([
      {
        tenantId: 'tenant-a',
        violationCount: 5,
        threshold: 3,
        windowMinutes: 5,
      },
    ]);
    expect(alertEvents.fire).toHaveBeenCalledWith(alerts[0]);
  });

  it('does not alert when below the threshold', async () => {
    const { service, persistence, tenantContext, alertEvents } = makeHarness();
    stubTenantList(persistence, ['tenant-a']);
    stubViolationCounts(tenantContext, { 'tenant-a': 1 });

    const alerts = await service.checkAllTenants();

    expect(alerts).toEqual([]);
    expect(alertEvents.fire).not.toHaveBeenCalled();
  });

  it('does not re-fire on a subsequent sweep while the condition is sustained', async () => {
    const { service, persistence, tenantContext, alertEvents } = makeHarness();
    stubTenantList(persistence, ['tenant-a']);
    stubViolationCounts(tenantContext, { 'tenant-a': 5 });

    await service.checkAllTenants();
    const secondSweep = await service.checkAllTenants();

    expect(secondSweep).toEqual([]);
    expect(alertEvents.fire).toHaveBeenCalledTimes(1);
  });

  it('sweeps every tenant independently', async () => {
    const { service, persistence, tenantContext } = makeHarness();
    stubTenantList(persistence, ['tenant-a', 'tenant-b']);
    stubViolationCounts(tenantContext, { 'tenant-a': 5, 'tenant-b': 0 });

    const alerts = await service.checkAllTenants();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].tenantId).toBe('tenant-a');
  });

  // Launch-integration fix (2026-09-17): this sweep had the same unbounded
  // Promise.all(tenantRows.map(...)) bug fixed elsewhere via
  // sweepTenantsWithBoundedConcurrency() (see sweep-tenants.ts) — one
  // tenant's failure used to fail the whole batch (Promise.all's fail-fast
  // semantics). Now it's logged and skipped, the rest still get checked.
  it("does not let one tenant's failure drop the rest of the sweep", async () => {
    const { service, persistence, tenantContext, alertEvents, logger } =
      makeHarness();
    stubTenantList(persistence, ['tenant-a', 'tenant-b']);
    tenantContext.withTenantTx.mockImplementation(
      (fn: (tx: unknown) => unknown, tenantId: string) => {
        if (tenantId === 'tenant-a') {
          return Promise.reject(new Error('connection timeout'));
        }
        return fn({
          select: () => ({
            from: () => ({
              where: () => Promise.resolve([{ count: 5 }]),
            }),
          }),
        });
      },
    );

    const alerts = await service.checkAllTenants();

    expect(alerts).toEqual([
      {
        tenantId: 'tenant-b',
        violationCount: 5,
        threshold: 3,
        windowMinutes: 5,
      },
    ]);
    expect(alertEvents.fire).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });
});
