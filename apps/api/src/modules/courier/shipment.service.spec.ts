// F26 (D5, D10): `applyStatusEvents` — the ONE place that decides "the status
// changed", where both the poll sweep and the J&T webhook converge.
//
// Three properties are load-bearing and each has a test:
//   - dedup, because polling re-reads the courier's WHOLE event list every
//     sweep and the history would otherwise grow by that list each time;
//   - forward-only for NOTIFICATION purposes, because couriers replay old
//     events and `delivered -> in_transit` must never message a customer;
//   - terminal statuses stop polling.
import type { AppLoggerService } from '../core';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import {
  DEFAULT_POLL_CADENCE_MS,
  POLL_CADENCE_MS,
  ShipmentService,
  type ShipmentRecord,
} from './shipment.service';
import {
  isForwardTransition,
  isTerminalStatus,
  type CourierStatusEvent,
} from './ports/courier-connector.port';

const TENANT = 'tenant-a';
const SHIPMENT = 'ship-1';

interface Row {
  id: string;
  tenantId: string;
  orderId: string;
  customerId: string;
  courierConnectionId: string;
  courier: string;
  trackingNumber: string;
  currentStatus: string;
  currentStatusAt: Date | null;
  estimatedDeliveryAt: Date | null;
  deliveredAt: Date | null;
  lastNotifiedStatus: string | null;
  lastNotifiedAt: Date | null;
  lastPolledAt: Date | null;
  pollFailureCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: SHIPMENT,
    tenantId: TENANT,
    orderId: 'order-1',
    customerId: 'customer-1',
    courierConnectionId: 'conn-1',
    courier: 'aramex',
    trackingNumber: 'AWB-1',
    currentStatus: 'in_transit',
    currentStatusAt: null,
    estimatedDeliveryAt: null,
    deliveredAt: null,
    lastNotifiedStatus: null,
    lastNotifiedAt: null,
    lastPolledAt: null,
    pollFailureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function event(
  status: CourierStatusEvent['status'],
  rawStatus: string,
  occurredAt: string,
): CourierStatusEvent {
  return { status, rawStatus, occurredAt: new Date(occurredAt) };
}

interface InsertChain {
  onConflictDoNothing: () => InsertChain;
  returning: () => Promise<Array<{ id: string }>>;
}

/**
 * A fake transaction that emulates the ONE database behaviour this method's
 * correctness rests on: the (shipment_id, raw_status, occurred_at) unique key
 * plus `onConflictDoNothing`, which is what makes a re-poll write nothing.
 */
function makeHarness(existing: Row = row()) {
  const history: Array<{ rawStatus: string; occurredAt: number }> = [];
  const updates: Array<Record<string, unknown>> = [];

  const tenantContext = {
    withTenantTx: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([existing]) }),
          }),
        }),
        insert: () => ({
          values: (values: Array<{ rawStatus: string; occurredAt: Date }>) => {
            const chain: InsertChain = {
              onConflictDoNothing: () => chain,
              returning: () =>
                Promise.resolve(
                  values
                    .filter((value) => {
                      const key = {
                        rawStatus: value.rawStatus,
                        occurredAt: value.occurredAt.getTime(),
                      };
                      const seen = history.some(
                        (h) =>
                          h.rawStatus === key.rawStatus &&
                          h.occurredAt === key.occurredAt,
                      );
                      if (seen) return false;
                      history.push(key);
                      return true;
                    })
                    .map((_, index) => ({ id: `evt-${index}` })),
                ),
            };
            return chain;
          },
        }),
        update: () => ({
          set: (patch: Record<string, unknown>) => {
            updates.push(patch);
            Object.assign(existing, patch);
            return { where: () => Promise.resolve([]) };
          },
        }),
      };

      return fn(tx);
    }),
  } as unknown as TenantContextService;

  const service = new ShipmentService(tenantContext, {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as AppLoggerService);

  return { service, history, updates, existing };
}

describe('ShipmentService.applyStatusEvents — dedup', () => {
  const events = [
    event('in_transit', 'SH003', '2026-09-18T08:00:00Z'),
    event('out_for_delivery', 'SH005', '2026-09-20T06:00:00Z'),
  ];

  it('writes the courier’s event list once, however many times it is re-read', async () => {
    const { service, history } = makeHarness();

    const first = await service.applyStatusEvents(
      TENANT,
      SHIPMENT,
      events,
      'poll',
    );
    const second = await service.applyStatusEvents(
      TENANT,
      SHIPMENT,
      events,
      'poll',
    );

    expect(first?.newEventCount).toBe(2);
    // The property that keeps re-polling free.
    expect(second?.newEventCount).toBe(0);
    expect(history).toHaveLength(2);
  });

  it('is a no-op for an empty event list', async () => {
    const { service } = makeHarness();

    expect(
      await service.applyStatusEvents(TENANT, SHIPMENT, [], 'poll'),
    ).toBeNull();
  });
});

describe('ShipmentService.applyStatusEvents — forward-only', () => {
  it('moves the status forward and flags the transition as notifiable', async () => {
    const { service, existing } = makeHarness(
      row({ currentStatus: 'in_transit' }),
    );

    const outcome = await service.applyStatusEvents(
      TENANT,
      SHIPMENT,
      [event('out_for_delivery', 'SH005', '2026-09-20T06:00:00Z')],
      'poll',
    );

    expect(outcome?.notifiableTransition).toBe(true);
    expect(outcome?.currentStatus).toBe('out_for_delivery');
    expect(existing.currentStatus).toBe('out_for_delivery');
  });

  // Couriers replay old scans. A regression is history, never a message.
  it('records a regression in history but never rewrites the status backwards', async () => {
    const { service, existing, history } = makeHarness(
      row({ currentStatus: 'delivered' }),
    );

    const outcome = await service.applyStatusEvents(
      TENANT,
      SHIPMENT,
      [event('in_transit', 'SH003', '2026-09-18T08:00:00Z')],
      'poll',
    );

    expect(outcome?.notifiableTransition).toBe(false);
    expect(outcome?.currentStatus).toBe('delivered');
    expect(existing.currentStatus).toBe('delivered');
    // Still recorded — the history is the audit trail, not the decision.
    expect(history).toHaveLength(1);
  });

  it('does not re-notify for the status the shipment is already in', async () => {
    const { service } = makeHarness(row({ currentStatus: 'out_for_delivery' }));

    const outcome = await service.applyStatusEvents(
      TENANT,
      SHIPMENT,
      [event('out_for_delivery', 'SH005-2', '2026-09-20T09:00:00Z')],
      'poll',
    );

    expect(outcome?.notifiableTransition).toBe(false);
  });

  it('takes the newest scan by occurrence time, not by arrival order', async () => {
    const { service, existing } = makeHarness(
      row({ currentStatus: 'picked_up' }),
    );

    await service.applyStatusEvents(
      TENANT,
      SHIPMENT,
      [
        event('out_for_delivery', 'SH005', '2026-09-20T06:00:00Z'),
        event('in_transit', 'SH003', '2026-09-18T08:00:00Z'),
      ],
      'poll',
    );

    expect(existing.currentStatus).toBe('out_for_delivery');
  });

  it('stamps delivered_at when the parcel is delivered', async () => {
    const { service, existing } = makeHarness();

    await service.applyStatusEvents(
      TENANT,
      SHIPMENT,
      [event('delivered', 'SH014', '2026-09-20T11:00:00Z')],
      'poll',
    );

    expect(existing.deliveredAt?.toISOString()).toBe(
      '2026-09-20T11:00:00.000Z',
    );
  });

  // A regression or a repeat is still a SUCCESSFUL read: it refreshes
  // last_polled_at so the sweep backs off, and clears the failure count.
  it('records a successful read even when nothing moved', async () => {
    const { service, updates } = makeHarness(
      row({ currentStatus: 'delivered', pollFailureCount: 4 }),
    );

    await service.applyStatusEvents(
      TENANT,
      SHIPMENT,
      [event('in_transit', 'SH003', '2026-09-18T08:00:00Z')],
      'poll',
    );

    expect(updates[0]).toMatchObject({ pollFailureCount: 0 });
    expect(updates[0].lastPolledAt).toBeInstanceOf(Date);
  });

  it('returns null for a shipment that is not in this tenant', async () => {
    const { service } = makeHarness();
    const tenantContext = {
      withTenantTx: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          select: () => ({
            from: () => ({
              where: () => ({ limit: () => Promise.resolve([]) }),
            }),
          }),
        }),
      ),
    } as unknown as TenantContextService;
    const scoped = new ShipmentService(tenantContext, {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as AppLoggerService);
    void service;

    expect(
      await scoped.applyStatusEvents(
        'tenant-b',
        SHIPMENT,
        [event('delivered', 'SH014', '2026-09-20T11:00:00Z')],
        'webhook',
      ),
    ).toBeNull();
  });
});

describe('status lifecycle helpers', () => {
  it('orders the lifecycle forward', () => {
    expect(isForwardTransition('in_transit', 'out_for_delivery')).toBe(true);
    expect(isForwardTransition('out_for_delivery', 'in_transit')).toBe(false);
    expect(isForwardTransition('delivered', 'in_transit')).toBe(false);
  });

  // `exception` and `unknown` are not progress in either direction, so they
  // never satisfy "moved forward" and never trigger a billed message.
  it('never treats exception or unknown as forward progress', () => {
    expect(isForwardTransition('in_transit', 'exception')).toBe(false);
    expect(isForwardTransition('exception', 'delivered')).toBe(false);
    expect(isForwardTransition('unknown', 'delivered')).toBe(false);
  });

  it('knows the three terminal statuses', () => {
    expect(isTerminalStatus('delivered')).toBe(true);
    expect(isTerminalStatus('returned')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('out_for_delivery')).toBe(false);
  });
});

describe('ShipmentService.isStale — the track_order refresh trigger (D4)', () => {
  const base: ShipmentRecord = {
    id: SHIPMENT,
    tenantId: TENANT,
    orderId: 'order-1',
    customerId: 'customer-1',
    courierConnectionId: 'conn-1',
    courier: 'aramex',
    trackingNumber: 'AWB-1',
    currentStatus: 'out_for_delivery',
    currentStatusAt: null,
    estimatedDeliveryAt: null,
    deliveredAt: null,
    lastNotifiedStatus: null,
    lastNotifiedAt: null,
    lastPolledAt: new Date('2026-09-20T12:00:00Z'),
    pollFailureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('never refreshes a terminal shipment — there is nothing left to learn', () => {
    expect(
      ShipmentService.isStale(
        { ...base, currentStatus: 'delivered' },
        new Date('2027-01-01T00:00:00Z'),
      ),
    ).toBe(false);
  });

  it('treats a never-polled shipment as stale', () => {
    expect(
      ShipmentService.isStale({ ...base, lastPolledAt: null }, new Date()),
    ).toBe(true);
  });

  it('uses the per-status cadence', () => {
    const polled = base.lastPolledAt!.getTime();
    const cadence = POLL_CADENCE_MS.out_for_delivery;

    expect(ShipmentService.isStale(base, new Date(polled + cadence - 1))).toBe(
      false,
    );
    expect(ShipmentService.isStale(base, new Date(polled + cadence + 1))).toBe(
      true,
    );
  });

  it('falls back to the default cadence for a status with no entry', () => {
    const polled = base.lastPolledAt!.getTime();
    const odd = { ...base, currentStatus: 'exception' as const };
    expect(
      ShipmentService.isStale(
        { ...odd, currentStatus: 'in_transit' },
        new Date(polled + DEFAULT_POLL_CADENCE_MS + 1),
      ),
    ).toBe(true);
  });
});

/**
 * The sweep's reads (Clarly 2.0 RLS fix): `shipments` is FORCE RLS, so a
 * platform-wide `runAdminQuery` read returned nothing. Both reads must now run
 * inside `withTenantTx` for the tenant being swept, and the rows they return
 * must be that tenant's.
 */
function makeReadHarness(rows: Row[]) {
  const where = jest.fn();
  const limit = jest.fn();
  const withTenantTx = jest.fn(
    async (fn: (tx: unknown) => Promise<unknown>, tenantId: string) => {
      void tenantId;
      const result = Promise.resolve(rows);
      const tx = {
        select: () => ({
          from: () => ({
            where: (...args: unknown[]) => {
              where(...args);
              // Awaitable directly (findByIds) or chained (findDueForPoll).
              return Object.assign(result, {
                orderBy: () => ({
                  limit: (n: number) => {
                    limit(n);
                    return result;
                  },
                }),
              });
            },
          }),
        }),
      };
      return fn(tx);
    },
  );
  const service = new ShipmentService(
    { withTenantTx } as unknown as TenantContextService,
    {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as unknown as AppLoggerService,
  );
  return { service, withTenantTx, where, limit };
}

describe('ShipmentService — per-tenant sweep reads', () => {
  it('findDueForPoll reads under the swept tenant’s transaction, bounded by the limit', async () => {
    const { service, withTenantTx, limit } = makeReadHarness([
      row({ id: 'ship-1' }),
      row({ id: 'ship-2' }),
    ]);

    const due = await service.findDueForPoll(
      TENANT,
      new Date('2026-10-06T10:00:00Z'),
      50,
    );

    expect(withTenantTx).toHaveBeenCalledTimes(1);
    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT);
    expect(limit).toHaveBeenCalledWith(50);
    expect(due.map((s) => s.id)).toEqual(['ship-1', 'ship-2']);
    expect(due[0]).toMatchObject({ tenantId: TENANT, trackingNumber: 'AWB-1' });
  });

  it('findByIds reads under the given tenant’s transaction', async () => {
    const { service, withTenantTx, where } = makeReadHarness([row()]);

    const found = await service.findByIds('tenant-b', [SHIPMENT]);

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), 'tenant-b');
    expect(where).toHaveBeenCalledTimes(1);
    expect(found.map((s) => s.id)).toEqual([SHIPMENT]);
  });

  it('findByIds does not open a transaction for an empty id list', async () => {
    const { service, withTenantTx } = makeReadHarness([row()]);

    expect(await service.findByIds(TENANT, [])).toEqual([]);
    expect(withTenantTx).not.toHaveBeenCalled();
  });
});
