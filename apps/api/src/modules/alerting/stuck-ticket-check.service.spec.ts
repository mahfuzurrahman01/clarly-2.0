import type { TenantPolicyService } from '../onboarding/tenant-policy.service';
import type { PersistenceService } from '../persistence/persistence.service';
import type { TicketQueryService } from '../ticket/ticket-query.service';
import type { TicketWithContext } from '../ticket/ticket.dto';
import { StuckTicketAlertEventsService } from './stuck-ticket-alert-events.service';
import type { AgentConfigService } from '../agent-config/agent-config.service';
import { StuckTicketCheckService } from './stuck-ticket-check.service';
import type { AppLoggerService } from '../core';

function makeLogger(): AppLoggerService {
  return { warn: jest.fn() } as unknown as AppLoggerService;
}

const NOW = new Date('2026-08-13T12:00:00Z');

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

function makeOpenTicket(
  overrides: Partial<TicketWithContext> = {},
): TicketWithContext {
  return {
    id: 'ticket-1',
    tenantId: 'tenant-a',
    customerId: 'customer-1',
    conversationId: null,
    escalationReason: 'TOOL_FAILURE',
    status: 'OPEN',
    note: null,
    assigneeId: null,
    confidence: null,
    citedChunkIds: null,
    claimedAt: null,
    resolvedAt: null,
    createdAt: minutesAgo(20),
    customerPhone: '+15550001111',
    customerName: null,
    customerLabel: null,
    customerLabelSource: null,
    transcript: [],
    ...overrides,
  };
}

function makeHarness(): {
  service: StuckTicketCheckService;
  persistence: { runAdminQuery: jest.Mock };
  tenantPolicy: { getForTenant: jest.Mock };
  ticketQuery: { listWithContext: jest.Mock };
  alertEvents: { fire: jest.Mock };
  getTenantBusinessHours: jest.Mock;
} {
  const persistence = { runAdminQuery: jest.fn() };
  const tenantPolicy = { getForTenant: jest.fn() };
  const ticketQuery = { listWithContext: jest.fn() };
  const alertEvents = { fire: jest.fn() };
  // Null = no single published agent, which keeps the sweep on wall-clock
  // minutes exactly as it behaved before business hours existed.
  const getTenantBusinessHours = jest.fn().mockResolvedValue(null);

  const service = new StuckTicketCheckService(
    persistence as unknown as PersistenceService,
    tenantPolicy as unknown as TenantPolicyService,
    ticketQuery as unknown as TicketQueryService,
    alertEvents as unknown as StuckTicketAlertEventsService,
    { getTenantBusinessHours } as unknown as AgentConfigService,
    makeLogger(),
  );

  return {
    service,
    persistence,
    tenantPolicy,
    ticketQuery,
    alertEvents,
    getTenantBusinessHours,
  };
}

describe('StuckTicketCheckService.checkAllTenants()', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires an alert for an OPEN, unclaimed ticket past its tenant threshold', async () => {
    const { service, persistence, tenantPolicy, ticketQuery, alertEvents } =
      makeHarness();
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({
          select: () => ({ from: () => Promise.resolve([{ id: 'tenant-a' }]) }),
        }),
    );
    tenantPolicy.getForTenant.mockResolvedValue({
      stuckTicketThresholdMinutes: 15,
    });
    const ticket = makeOpenTicket({ createdAt: minutesAgo(20) });
    ticketQuery.listWithContext.mockResolvedValue([ticket]);

    const alerts = await service.checkAllTenants();

    expect(alerts).toEqual([
      {
        tenantId: 'tenant-a',
        ticketId: ticket.id,
        customerId: ticket.customerId,
        createdAt: ticket.createdAt,
        unclaimedMinutes: 20,
        thresholdMinutes: 15,
      },
    ]);
    expect(alertEvents.fire).toHaveBeenCalledWith(alerts[0]);
  });

  it("does not alert on a ticket younger than the tenant's threshold", async () => {
    const { service, persistence, tenantPolicy, ticketQuery, alertEvents } =
      makeHarness();
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({
          select: () => ({ from: () => Promise.resolve([{ id: 'tenant-a' }]) }),
        }),
    );
    tenantPolicy.getForTenant.mockResolvedValue({
      stuckTicketThresholdMinutes: 15,
    });
    ticketQuery.listWithContext.mockResolvedValue([
      makeOpenTicket({ createdAt: minutesAgo(5) }),
    ]);

    const alerts = await service.checkAllTenants();

    expect(alerts).toEqual([]);
    expect(alertEvents.fire).not.toHaveBeenCalled();
  });

  it('defaults to a 15-minute threshold when the tenant has no seeded tenant_policy row', async () => {
    const { service, persistence, tenantPolicy, ticketQuery } = makeHarness();
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({
          select: () => ({ from: () => Promise.resolve([{ id: 'tenant-a' }]) }),
        }),
    );
    tenantPolicy.getForTenant.mockResolvedValue(null);
    ticketQuery.listWithContext.mockResolvedValue([
      makeOpenTicket({ createdAt: minutesAgo(16) }),
    ]);

    const alerts = await service.checkAllTenants();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].thresholdMinutes).toBe(15);
  });

  it('sweeps every tenant independently, each against its own threshold', async () => {
    const { service, persistence, tenantPolicy, ticketQuery } = makeHarness();
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({
          select: () => ({
            from: () =>
              Promise.resolve([{ id: 'tenant-a' }, { id: 'tenant-b' }]),
          }),
        }),
    );
    tenantPolicy.getForTenant.mockImplementation((tenantId: string) =>
      Promise.resolve({
        stuckTicketThresholdMinutes: tenantId === 'tenant-a' ? 15 : 30,
      }),
    );
    ticketQuery.listWithContext.mockImplementation((tenantId: string) =>
      Promise.resolve([
        makeOpenTicket({
          id: `${tenantId}-ticket`,
          tenantId,
          createdAt: minutesAgo(20),
        }),
      ]),
    );

    const alerts = await service.checkAllTenants();

    // tenant-a's ticket is 20m old, past its 15m threshold; tenant-b's
    // ticket is also 20m old but under its 30m threshold.
    expect(alerts).toHaveLength(1);
    expect(alerts[0].tenantId).toBe('tenant-a');
  });

  it('never alerts on a claimed ticket (defensive — OPEN tickets should never have claimedAt set)', async () => {
    const { service, persistence, tenantPolicy, ticketQuery } = makeHarness();
    persistence.runAdminQuery.mockImplementation(
      (fn: (db: unknown) => unknown) =>
        fn({
          select: () => ({ from: () => Promise.resolve([{ id: 'tenant-a' }]) }),
        }),
    );
    tenantPolicy.getForTenant.mockResolvedValue({
      stuckTicketThresholdMinutes: 15,
    });
    ticketQuery.listWithContext.mockResolvedValue([
      makeOpenTicket({ createdAt: minutesAgo(20), claimedAt: minutesAgo(1) }),
    ]);

    const alerts = await service.checkAllTenants();

    expect(alerts).toEqual([]);
  });
});

describe('StuckTicketCheckService business hours', () => {
  it('does not flag a ticket that has only aged outside opening hours', async () => {
    const {
      service,
      persistence,
      tenantPolicy,
      ticketQuery,
      alertEvents,
      getTenantBusinessHours,
    } = makeHarness();

    persistence.runAdminQuery.mockResolvedValue([{ id: 'tenant-a' }]);
    tenantPolicy.getForTenant.mockResolvedValue({
      stuckTicketThresholdMinutes: 15,
    });
    getTenantBusinessHours.mockResolvedValue({
      hours: { mon: { open: '09:00', close: '17:00' } },
      timezone: 'Asia/Dhaka',
    });
    // Created on a Sunday: hours out of wall-clock, zero business minutes.
    ticketQuery.listWithContext.mockResolvedValue([
      {
        id: 'ticket-1',
        customerId: 'customer-1',
        claimedAt: null,
        createdAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      },
    ]);

    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-08-16T12:00:00Z').getTime());

    const alerts = await service.checkAllTenants();

    expect(alerts).toHaveLength(0);
    expect(alertEvents.fire).not.toHaveBeenCalled();

    jest.restoreAllMocks();
  });

  it('still flags a ticket that has sat unclaimed through open hours', async () => {
    const {
      service,
      persistence,
      tenantPolicy,
      ticketQuery,
      getTenantBusinessHours,
    } = makeHarness();

    persistence.runAdminQuery.mockResolvedValue([{ id: 'tenant-a' }]);
    tenantPolicy.getForTenant.mockResolvedValue({
      stuckTicketThresholdMinutes: 15,
    });
    getTenantBusinessHours.mockResolvedValue({
      hours: { tue: { open: '09:00', close: '17:00' } },
      timezone: 'Asia/Dhaka',
    });
    // Tuesday 10:00 Dhaka, checked at Tuesday 12:00 Dhaka: two open hours.
    ticketQuery.listWithContext.mockResolvedValue([
      {
        id: 'ticket-1',
        customerId: 'customer-1',
        claimedAt: null,
        createdAt: new Date('2026-08-18T04:00:00Z'),
      },
    ]);

    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-08-18T06:00:00Z').getTime());

    const alerts = await service.checkAllTenants();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].unclaimedMinutes).toBe(120);

    jest.restoreAllMocks();
  });
});
