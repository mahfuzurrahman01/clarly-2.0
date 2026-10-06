// F25 D9: the money path — the write itself.
//
// Unlike the other service specs here, this one RUNS the transaction callback,
// against a recording fake of the drizzle query builder. That is deliberate:
// the properties being asserted are about what goes INTO the insert (the
// catalogue's price, never the model's; the status the mode dictates; the
// notification in the SAME transaction) and about which recovery each unique
// violation triggers — none of which is visible if the callback is skipped.
import { ToolScopeViolation } from '@repo/errors';
import type { AppLoggerService, Clock } from '../core';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { OrderService, type CreateOrderCommand } from './order.service';

const TENANT = '00000000-0000-0000-0000-00000000000a';
const CONVERSATION = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '22222222-2222-2222-2222-222222222222';
const PRODUCT = '33333333-3333-3333-3333-333333333333';
const NOW = new Date('2026-09-22T12:00:00.000Z');

interface Call {
  method: string;
  args: unknown[];
}

/**
 * A thenable proxy standing in for a drizzle query builder: every method
 * returns the builder, and awaiting it yields the next scripted result. A
 * scripted `Error` is thrown instead, which is how a unique violation is
 * simulated without a database.
 */
function makeTx(script: unknown[], calls: Call[]): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          const next = script.shift();
          return (
            resolve: (value: unknown) => void,
            reject: (reason: unknown) => void,
          ) => (next instanceof Error ? reject(next) : resolve(next));
        }
        return (...args: unknown[]) => {
          calls.push({ method: String(prop), args });
          return proxy;
        };
      },
    },
  );
  return proxy;
}

function uniqueViolation(constraint: string): Error {
  return Object.assign(new Error(`duplicate key value`), {
    code: '23505',
    constraint,
  });
}

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT,
    tenantId: TENANT,
    name: 'Oud Perfume 50ml',
    sku: 'OUD-50',
    price: '500.00',
    currency: 'SAR',
    stock: 10,
    isActive: true,
    metadata: null,
    ...overrides,
  };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    tenantId: TENANT,
    reference: 'ORD-7F3A21',
    customerId: CUSTOMER,
    conversationId: CONVERSATION,
    status: 'pending_approval',
    contactName: 'Aisha',
    contactPhone: '+966501234567',
    city: null,
    address: 'Riyadh',
    notes: null,
    paymentMethod: 'cod',
    paymentStatus: 'unpaid',
    subtotal: '1000.00',
    total: '1000.00',
    currency: 'SAR',
    storeConnectionId: null,
    storeSyncStatus: 'not_applicable',
    externalOrderId: null,
    storeSyncAttempts: 0,
    storeSyncError: null,
    approvedBy: null,
    approvedAt: null,
    rejectedReason: null,
    customerNotifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    productId: PRODUCT,
    productName: 'Oud Perfume 50ml',
    sku: 'OUD-50',
    unitPrice: '500.00',
    currency: 'SAR',
    quantity: 2,
    lineTotal: '1000.00',
    externalProductId: null,
    externalVariantId: null,
    ...overrides,
  };
}

function makeHarness(script: unknown[]) {
  const calls: Call[] = [];
  const withTenantTx = jest.fn((callback: (tx: unknown) => unknown) =>
    Promise.resolve(callback(makeTx(script, calls))),
  );

  const clock: Clock = { now: () => NOW, nowMs: () => NOW.getTime() };

  const service = new OrderService(
    { withTenantTx } as unknown as TenantContextService,
    clock,
    {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as AppLoggerService,
  );

  return { service, calls, withTenantTx };
}

function command(
  overrides: Partial<CreateOrderCommand> = {},
): CreateOrderCommand {
  return {
    tenantId: TENANT,
    conversationId: CONVERSATION,
    customerId: CUSTOMER,
    turnId: 'turn-1',
    contactName: 'Aisha',
    contactPhone: '+966501234567',
    address: 'Riyadh',
    city: null,
    notes: null,
    items: [{ productId: PRODUCT, quantity: 2 }],
    storeConnectionId: null,
    storeProvider: null,
    ...overrides,
  };
}

/** The happy path's script: mode, products, order insert, items insert, notification. */
function happyScript(mode: string, order = orderRow()) {
  return [[{ mode }], [productRow()], [order], [itemRow()], undefined];
}

function insertedOrderValues(calls: Call[]): Record<string, unknown> {
  // The first `values(...)` in the transaction is the order's own.
  const call = calls.find((entry) => entry.method === 'values');
  return (call?.args[0] ?? {}) as Record<string, unknown>;
}

describe('OrderService.createFromTurn — the execution gate (D1.2 gate 2)', () => {
  it.each([['disabled'], [undefined]])(
    'refuses with ToolScopeViolation when the mode reads as %s, writing nothing',
    async (mode) => {
      const { service, calls } = makeHarness([
        mode === undefined ? [] : [{ mode }],
      ]);

      await expect(service.createFromTurn(command())).rejects.toBeInstanceOf(
        ToolScopeViolation,
      );
      // Not one insert — the gate is checked before the catalogue is even read.
      expect(calls.some((entry) => entry.method === 'values')).toBe(false);
    },
  );
});

describe('OrderService.createFromTurn — what gets written', () => {
  it('opens a human_approval order as pending_approval, with its notification in the SAME transaction', async () => {
    const { service, calls, withTenantTx } = makeHarness(
      happyScript('human_approval'),
    );

    const result = await service.createFromTurn(command());

    expect(result.duplicate).toBe(false);
    expect(result.order.status).toBe('pending_approval');
    // One transaction for the whole write: an order that committed with no
    // notification is an order nobody knows to approve.
    expect(withTenantTx).toHaveBeenCalledTimes(1);
    const notification = calls
      .filter((entry) => entry.method === 'values')
      .map((entry) => entry.args[0] as Record<string, unknown>)
      .find((values) => values.kind === 'order_pending_approval');
    expect(notification).toMatchObject({
      kind: 'order_pending_approval',
      severity: 'warning',
      entityType: 'order',
    });
    // QA 2026-10-05: the console localises from these, so they must be the
    // very values the English title/body were written from.
    const params = (notification as { params: Record<string, unknown> }).params;
    expect(Object.keys(params).sort()).toEqual([
      'count',
      'currency',
      'customer',
      'orderRef',
      'total',
    ]);
    expect((notification as { title: string }).title).toBe(
      `Order ${String(params.orderRef)} is waiting for approval`,
    );
    expect((notification as { body: string }).body).toContain(
      `${String(params.count)} item(s), ${String(params.total)} ${String(params.currency)}, for ${String(params.customer)}.`,
    );
  });

  it('opens an auto-mode order as confirmed and raises NO approval notification', async () => {
    const { service, calls } = makeHarness([
      [{ mode: 'auto' }],
      [productRow()],
      [orderRow({ status: 'confirmed' })],
      [itemRow()],
    ]);

    const result = await service.createFromTurn(command());

    expect(result.order.status).toBe('confirmed');
    expect(
      calls
        .filter((entry) => entry.method === 'values')
        .some(
          (entry) =>
            (entry.args[0] as Record<string, unknown>).kind ===
            'order_pending_approval',
        ),
    ).toBe(false);
  });

  it('takes the price and the name from the PRODUCTS row, never from the tool call', async () => {
    const { service, calls } = makeHarness(happyScript('human_approval'));

    await service.createFromTurn(command());

    // The tool schema carries no price at all, and the stored subtotal is
    // 2 x the catalogue's 500.00 — not anything a customer could have talked
    // the model into.
    expect(insertedOrderValues(calls)).toMatchObject({
      subtotal: '1000.00',
      total: '1000.00',
      currency: 'SAR',
    });
  });

  it('sets total = subtotal: phase 1 has no shipping cost and no VAT (D3)', async () => {
    const values = (() => {
      const { service, calls } = makeHarness(happyScript('human_approval'));
      return service.createFromTurn(command()).then(() => calls);
    })();

    const inserted = insertedOrderValues(await values);
    expect(inserted.total).toBe(inserted.subtotal);
  });

  it('records customer and conversation from the command, and a generated reference', async () => {
    const { service, calls } = makeHarness(happyScript('human_approval'));

    await service.createFromTurn(command());

    const values = insertedOrderValues(calls);
    expect(values).toMatchObject({
      customerId: CUSTOMER,
      conversationId: CONVERSATION,
      status: 'pending_approval',
    });
    expect(values.reference).toMatch(/^ORD-[A-Z0-9]{6}$/);
    // Derived, never supplied.
    expect(values.idempotencyKey).toHaveLength(64);
    expect(values.contentHash).toHaveLength(64);
  });

  it('leaves the sync not_applicable when no item resolved an external id', async () => {
    const { service, calls } = makeHarness([
      [{ mode: 'auto' }],
      [productRow()],
      [orderRow({ status: 'confirmed' })],
      [itemRow()],
    ]);

    await service.createFromTurn(
      command({ storeConnectionId: 'conn-1', storeProvider: 'salla' }),
    );

    expect(insertedOrderValues(calls)).toMatchObject({
      storeConnectionId: null,
      storeSyncStatus: 'not_applicable',
    });
  });

  it('pins the connection and queues the sync when every item is linked', async () => {
    const { service, calls } = makeHarness([
      [{ mode: 'auto' }],
      [
        productRow({
          metadata: { source: 'salla', storeExternalId: 'salla-99' },
        }),
      ],
      [orderRow({ status: 'confirmed' })],
      [itemRow({ externalProductId: 'salla-99' })],
    ]);

    await service.createFromTurn(
      command({ storeConnectionId: 'conn-1', storeProvider: 'salla' }),
    );

    expect(insertedOrderValues(calls)).toMatchObject({
      storeConnectionId: 'conn-1',
      storeSyncStatus: 'pending',
    });
  });

  it('leaves a pending_approval order NOT pending sync — nothing goes to a store unapproved', async () => {
    const { service, calls } = makeHarness([
      [{ mode: 'human_approval' }],
      [
        productRow({
          metadata: { source: 'salla', storeExternalId: 'salla-99' },
        }),
      ],
      [orderRow()],
      [itemRow({ externalProductId: 'salla-99' })],
      undefined,
    ]);

    await service.createFromTurn(
      command({ storeConnectionId: 'conn-1', storeProvider: 'salla' }),
    );

    expect(insertedOrderValues(calls).storeSyncStatus).toBe('not_applicable');
  });

  it('fails the whole order, persisting nothing, when an item cannot be resolved', async () => {
    const { service, calls } = makeHarness([
      [{ mode: 'human_approval' }],
      [productRow({ isActive: false })],
    ]);

    await expect(service.createFromTurn(command())).rejects.toThrow(
      /no longer available/,
    );
    expect(calls.some((entry) => entry.method === 'values')).toBe(false);
  });
});

describe('OrderService.createFromTurn — exactly one order (D6.2)', () => {
  it('races 1 & 2: an existing idempotency key re-reads the order and flags it duplicate', async () => {
    const { service } = makeHarness([
      [{ mode: 'human_approval' }],
      [productRow()],
      [], // ON CONFLICT DO NOTHING matched: zero rows back
      [orderRow()], // findByIdempotencyKey
      [itemRow()], // withItems
    ]);

    const result = await service.createFromTurn(command());

    expect(result.duplicate).toBe(true);
    expect(result.order.reference).toBe('ORD-7F3A21');
  });

  it('race 3: the pending-dedup index catches a DIFFERENT turn ordering the same thing', async () => {
    const { service } = makeHarness([
      [{ mode: 'human_approval' }],
      [productRow()],
      uniqueViolation('orders_pending_dedup_idx'),
      [orderRow()], // findPendingByContentHash
      [itemRow()],
    ]);

    const result = await service.createFromTurn(command());

    expect(result.duplicate).toBe(true);
  });

  it('retries blind on a reference collision and succeeds on the next draw', async () => {
    const { service } = makeHarness([
      [{ mode: 'human_approval' }],
      [productRow()],
      uniqueViolation('orders_tenant_id_reference_unique'),
      ...happyScript('human_approval'),
    ]);

    await expect(service.createFromTurn(command())).resolves.toMatchObject({
      duplicate: false,
    });
  });

  it('gives up rather than looping forever when references keep colliding', async () => {
    const collision = () => [
      [{ mode: 'human_approval' }],
      [productRow()],
      uniqueViolation('orders_tenant_id_reference_unique'),
    ];
    const { service } = makeHarness([
      ...collision(),
      ...collision(),
      ...collision(),
    ]);

    await expect(service.createFromTurn(command())).rejects.toThrow(
      /after 3 attempts/,
    );
  });

  it('lets an unrelated constraint violation through rather than swallowing it', async () => {
    const { service } = makeHarness([
      [{ mode: 'human_approval' }],
      [productRow()],
      uniqueViolation('some_other_constraint'),
    ]);

    await expect(service.createFromTurn(command())).rejects.toMatchObject({
      constraint: 'some_other_constraint',
    });
  });
});

describe('OrderService — console reads', () => {
  it('404-shapes an order this tenant cannot see by returning null', async () => {
    const { service } = makeHarness([[]]);

    await expect(service.get(TENANT, 'order-1')).resolves.toBeNull();
  });

  it('pages with an opaque cursor and reports the last page as null', async () => {
    const { service } = makeHarness([[orderRow()]]);

    const page = await service.list(TENANT, { limit: 20 });

    expect(page.orders).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
  });

  it('hands back a cursor when a further page exists', async () => {
    const { service } = makeHarness([
      [orderRow({ id: 'a' }), orderRow({ id: 'b' })],
    ]);

    const page = await service.list(TENANT, { limit: 1 });

    expect(page.orders).toHaveLength(1);
    expect(typeof page.nextCursor).toBe('string');
  });
});
