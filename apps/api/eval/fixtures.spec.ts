// L2 `--runs N` isolation (see findExistingOrderIdsForConversation()'s own
// header in fixtures.ts): a case run more than once reuses the SAME
// conversation across runs, so runner.ts must baseline every order that
// ALREADY exists on that conversation before scoring a run's own turns —
// not just the fixture-seeded ones (which never match this query anyway,
// since seedFixtures() writes them with conversationId: null).
import type { TenantContextService } from '../src/modules/tenant-context/tenant-context.service';
import {
  findExistingOrderIdsForConversation,
  resolveShipmentEta,
  retireEvalPendingOrders,
  seedShipments,
  type FixtureServices,
  type FixtureShipment,
  type SeededOrder,
} from './fixtures';

/**
 * A minimal drizzle-shaped fake: `withTenantTx` runs the callback against a
 * `tx` whose `.select().from().where()` chain resolves to canned rows,
 * exactly like the real query builder's thenable. Good enough to prove the
 * FUNCTION SHAPE (it asks for and returns order ids) without a live
 * Postgres — the tenant-scoping itself is `TenantContextService`'s own
 * contract, already covered elsewhere.
 */
function fakeTenantContext(rows: Array<{ id: string }>): TenantContextService {
  const tx = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  };
  return {
    withTenantTx: async (fn: (tx: unknown) => unknown) => fn(tx),
  } as unknown as TenantContextService;
}

describe('findExistingOrderIdsForConversation()', () => {
  it('returns every order id already on the conversation', async () => {
    const ids = await findExistingOrderIdsForConversation(
      fakeTenantContext([{ id: 'order-1' }, { id: 'order-2' }]),
      'tenant-1',
      'conversation-1',
    );
    expect(ids).toEqual(['order-1', 'order-2']);
  });

  it('returns an empty list for a conversation with no orders yet (run 1 of a fresh case)', async () => {
    const ids = await findExistingOrderIdsForConversation(
      fakeTenantContext([]),
      'tenant-1',
      'conversation-1',
    );
    expect(ids).toEqual([]);
  });
});

// Run 2+ of an order case hit OrderService's pending-order dedup (same
// conversation, same content) and got run 1's order back, so no new row
// appeared and every expectOrder case failed. Cancelling earlier runs'
// pending orders restores run 1's starting state.
describe('retireEvalPendingOrders()', () => {
  it("cancels the conversation's pending orders inside the tenant tx", async () => {
    const set = jest.fn();
    const where = jest.fn().mockResolvedValue(undefined);
    set.mockReturnValue({ where });
    const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
      fn({ update: () => ({ set }) }),
    );

    await retireEvalPendingOrders(
      { withTenantTx } as unknown as TenantContextService,
      'tenant-1',
      'conversation-1',
      ['seeded-order'],
    );

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), 'tenant-1');
    expect(set).toHaveBeenCalledWith({ status: 'cancelled' });
    expect(where).toHaveBeenCalledTimes(1);
  });
});

describe('resolveShipmentEta()', () => {
  const now = new Date('2026-10-03T15:42:10Z');

  it('anchors a relative offset to 00:00 UTC of the run date, so the seed never goes stale', () => {
    expect(
      resolveShipmentEta({ estimatedDeliveryInDays: 0 }, now)?.toISOString(),
    ).toBe('2026-10-03T00:00:00.000Z');
    expect(
      resolveShipmentEta({ estimatedDeliveryInDays: 2 }, now)?.toISOString(),
    ).toBe('2026-10-05T00:00:00.000Z');
    expect(
      resolveShipmentEta({ estimatedDeliveryInDays: -5 }, now)?.toISOString(),
    ).toBe('2026-09-28T00:00:00.000Z');
  });

  it('prefers the relative offset over an absolute date, and falls back to the absolute date', () => {
    expect(
      resolveShipmentEta(
        {
          estimatedDeliveryAt: '2026-01-01T00:00:00Z',
          estimatedDeliveryInDays: 1,
        },
        now,
      )?.toISOString(),
    ).toBe('2026-10-04T00:00:00.000Z');
    expect(
      resolveShipmentEta(
        { estimatedDeliveryAt: '2026-09-20T00:00:00Z' },
        now,
      )?.toISOString(),
    ).toBe('2026-09-20T00:00:00.000Z');
    expect(resolveShipmentEta({}, now)).toBeUndefined();
  });
});

// Cycle 3: AWB-100-2004 declared `exception` seeded as `label_created`
// because applyStatusEvents() only moves a shipment forward along the ladder
// and `exception` is outside it. The seeder must land on the declared status.
describe('seedShipments() — a status outside the forward ladder', () => {
  const order: SeededOrder = {
    id: 'order-1',
    reference: 'ORD-1',
    customerId: 'customer-1',
    customerIndex: 0,
  };

  function harness(outcomeStatus: string) {
    const set = jest.fn();
    const where = jest.fn().mockResolvedValue(undefined);
    set.mockReturnValue({ where });
    const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
      fn({ update: () => ({ set }) }),
    );
    const applyStatusEvents = jest.fn().mockResolvedValue({
      shipmentId: 'shipment-1',
      newEventCount: 1,
      previousStatus: 'label_created',
      currentStatus: outcomeStatus,
      notifiableTransition: false,
    });
    const services = {
      courierConnections: {
        upsert: jest.fn().mockResolvedValue({ id: 'conn-1' }),
      },
      shipments: {
        create: jest.fn().mockResolvedValue({ id: 'shipment-1' }),
        applyStatusEvents,
      },
      tenantContext: { withTenantTx },
    } as unknown as Pick<
      FixtureServices,
      'courierConnections' | 'shipments' | 'tenantContext'
    >;
    return { services, set, where, applyStatusEvents, withTenantTx };
  }

  const shipment = (status: FixtureShipment['status']): FixtureShipment => ({
    orderIndex: 0,
    courier: 'jt',
    trackingNumber: 'AWB-100-2004',
    status,
    estimatedDeliveryInDays: -5,
  });

  it('writes the declared `exception` status when the ladder refused to move to it', async () => {
    const { services, set, where, withTenantTx } = harness('label_created');
    const refs = new Map<number, string[]>();

    await seedShipments(
      services,
      'tenant-1',
      [shipment('exception')],
      [order],
      refs,
    );

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), 'tenant-1');
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ currentStatus: 'exception' }),
    );
    expect(where).toHaveBeenCalledTimes(1);
    expect(refs.get(0)).toEqual(['AWB-100-2004']);
  });

  it('does not touch the row when the ladder already moved to the declared status', async () => {
    const { services, set } = harness('in_transit');

    await seedShipments(
      services,
      'tenant-1',
      [shipment('in_transit')],
      [order],
      new Map(),
    );

    expect(set).not.toHaveBeenCalled();
  });

  it('passes the relative ETA through to applyStatusEvents as a Date', async () => {
    const { services, applyStatusEvents } = harness('in_transit');

    await seedShipments(
      services,
      'tenant-1',
      [shipment('in_transit')],
      [order],
      new Map(),
    );

    expect(applyStatusEvents.mock.calls[0][4]).toBeInstanceOf(Date);
  });
});
