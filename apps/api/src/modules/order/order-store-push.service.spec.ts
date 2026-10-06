// F25 D9: "push processor: provider throws -> status stays `confirmed`,
// `store_sync_status='failed'`, attempts incremented; already-`synced` order ->
// provider NOT called; success writes `external_order_id` and `synced` in one
// transaction."
//
// The invariant underneath all of them: THIS CLASS NEVER TOUCHES
// `orders.status`. A customer's order is real whether or not Salla accepted it.
import type { AppLoggerService } from '../core';
import type { NotificationService } from '../notifications/notification.service';
import type { StoreConnectionService } from '../store/store-connection.service';
import type { StoreOAuthService } from '../store/store-oauth.service';
import type { StoreProviderRegistry } from '../store/store-provider.registry';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { OrderStorePushService } from './order-store-push.service';
import { ORDER_STORE_PUSH_ATTEMPTS } from './order-store-push.queue';
import { markEntityNotificationsRead } from '../notifications/notification-resolution';
import { scriptedTx } from '../../test-support/__fixtures__/scripted-tx';

jest.mock('../notifications/notification-resolution', () => ({
  markEntityNotificationsRead: jest.fn().mockResolvedValue(1),
}));

const TENANT = '00000000-0000-0000-0000-00000000000a';
const ORDER_ID = '11111111-1111-1111-1111-111111111111';

type Row = Record<string, unknown>;

function orderRow(overrides: Row = {}): Row {
  return {
    id: ORDER_ID,
    tenantId: TENANT,
    reference: 'ORD-7F3A21',
    status: 'confirmed',
    storeConnectionId: 'conn-1',
    storeSyncStatus: 'pending',
    storeSyncAttempts: 0,
    contactName: 'Aisha',
    contactPhone: '+966501234567',
    address: 'Riyadh',
    notes: null,
    ...overrides,
  };
}

function itemRow(overrides: Row = {}): Row {
  return {
    externalProductId: 'salla-99',
    externalVariantId: null,
    quantity: 2,
    unitPrice: '500.00',
    ...overrides,
  };
}

function makeHarness(
  script: unknown[],
  options: {
    createOrder?: jest.Mock;
    connection?: Row | null;
  } = {},
) {
  const queue = [...script];
  const withTenantTx = jest.fn(() => Promise.resolve(queue.shift()));
  const createOrder =
    options.createOrder ??
    jest.fn().mockResolvedValue({ orderId: 'salla-order-1', paymentUrl: null });
  const findById = jest
    .fn()
    .mockResolvedValue(
      options.connection === undefined
        ? { id: 'conn-1', provider: 'salla', isActive: true, storeId: 'shop-1' }
        : options.connection,
    );
  const ensureCredentials = jest
    .fn()
    .mockResolvedValue({ accessToken: 'token', authorizationToken: undefined });
  const forProvider = jest.fn().mockReturnValue({ createOrder });
  const record = jest.fn().mockResolvedValue(undefined);

  const service = new OrderStorePushService(
    { withTenantTx } as unknown as TenantContextService,
    { findById } as unknown as StoreConnectionService,
    { ensureCredentials } as unknown as StoreOAuthService,
    { forProvider } as unknown as StoreProviderRegistry,
    { record } as unknown as NotificationService,
    {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as AppLoggerService,
  );

  return { service, withTenantTx, createOrder, record, findById };
}

/**
 * The first `withTenantTx` in `push()` is the FOR UPDATE prepare, and it
 * returns a decision object rather than rows. The stub does not run the
 * callback, so the script's first entry IS that decision.
 */
function prepared(order: Row = orderRow(), items: Row[] = [itemRow()]) {
  return { outcome: 'proceed' as const, order, items };
}

describe('OrderStorePushService.push — at most once (D6.2 race #5)', () => {
  it('does not call the provider for an order already synced', async () => {
    const { service, createOrder } = makeHarness([
      { outcome: 'already_synced' as const },
    ]);

    await expect(service.push(TENANT, ORDER_ID)).resolves.toBe(
      'already_synced',
    );
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('does nothing for an order that was cancelled while the job sat in the queue', async () => {
    const { service, createOrder } = makeHarness([
      { outcome: 'not_applicable' as const },
    ]);

    await expect(service.push(TENANT, ORDER_ID)).resolves.toBe(
      'not_applicable',
    );
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('does nothing for a tenant with no pinned store connection (D4.3)', async () => {
    const { service, createOrder } = makeHarness([
      { outcome: 'not_applicable' as const },
    ]);

    await expect(service.push(TENANT, ORDER_ID)).resolves.toBe(
      'not_applicable',
    );
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('does nothing when the order row has vanished', async () => {
    const { service, createOrder } = makeHarness([
      { outcome: 'not_applicable' as const },
    ]);

    await expect(service.push(TENANT, ORDER_ID)).resolves.toBe(
      'not_applicable',
    );
    expect(createOrder).not.toHaveBeenCalled();
  });
});

describe('OrderStorePushService.push — success', () => {
  it('sends the SNAPSHOTTED external ids and prices, not the current catalogue', async () => {
    const { service, createOrder } = makeHarness([
      prepared(),
      undefined, // the synced UPDATE
    ]);

    await expect(service.push(TENANT, ORDER_ID)).resolves.toBe('synced');
    expect(createOrder).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({
        customerName: 'Aisha',
        items: [
          expect.objectContaining({
            productId: 'salla-99',
            quantity: 2,
            price: 500,
          }),
        ],
      }),
      { shop: 'shop-1' },
    );
  });
});

describe('OrderStorePushService.push — retiring a stale failure notification', () => {
  it('marks order_store_push_failed read in the transaction that records the sync', async () => {
    const resolveMock = jest.mocked(markEntityNotificationsRead);
    resolveMock.mockClear();
    const { service, withTenantTx } = makeHarness([]);
    const syncTx = scriptedTx([[{ id: ORDER_ID }]]);
    withTenantTx
      .mockReset()
      // prepare: answered directly
      .mockImplementationOnce(() => Promise.resolve(prepared()))
      // the success write: its callback actually runs, against a scripted tx
      .mockImplementationOnce(((fn: (tx: unknown) => unknown) =>
        Promise.resolve(fn(syncTx))) as never);

    await expect(service.push(TENANT, ORDER_ID)).resolves.toBe('synced');

    expect(resolveMock).toHaveBeenCalledTimes(1);
    const [tx, input] = resolveMock.mock.calls[0];
    expect(tx).toBe(syncTx);
    expect(input).toMatchObject({
      tenantId: TENANT,
      entityType: 'order',
      entityIds: [ORDER_ID],
      kinds: ['order_store_push_failed'],
    });
  });
});

describe('OrderStorePushService.push — failure (D4.6)', () => {
  it('asks BullMQ to retry while attempts remain, without touching the order status', async () => {
    const createOrder = jest.fn().mockRejectedValue(new Error('Salla 503'));
    const { service, withTenantTx, record } = makeHarness(
      [
        prepared(),
        [{ attempts: 1 }], // recordAttempt
      ],
      { createOrder },
    );

    await expect(service.push(TENANT, ORDER_ID)).resolves.toBe(
      'retryable_failure',
    );
    // No notification yet — one per exhausted push, not one per attempt.
    expect(record).not.toHaveBeenCalled();
    expect(withTenantTx).toHaveBeenCalledTimes(2);
  });

  it('marks the SYNC failed and notifies the merchant once attempts are exhausted', async () => {
    const createOrder = jest.fn().mockRejectedValue(new Error('Salla 503'));
    const { service, record } = makeHarness(
      [
        prepared(),
        [{ attempts: ORDER_STORE_PUSH_ATTEMPTS }], // recordAttempt
        [{ reference: 'ORD-7F3A21' }], // recordFailure
      ],
      { createOrder },
    );

    await expect(service.push(TENANT, ORDER_ID)).resolves.toBe('exhausted');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'order_store_push_failed',
        severity: 'critical',
        entityType: 'order',
        entityId: ORDER_ID,
        dedupKey: `order_store_push_failed:${ORDER_ID}`,
      }),
    );
    // The notification says the order is real and the customer was told — the
    // merchant's action is to enter it by hand or retry, never to re-take it.
    const recorded = record.mock.calls as Array<[{ body: string }]>;
    expect(recorded[0]?.[0].body).toContain('confirmed in Clarly');
  });

  it('gives up immediately when the pinned connection is gone or inactive', async () => {
    const { service, createOrder, record } = makeHarness(
      [prepared(), [{ reference: 'ORD-7F3A21' }]],
      { connection: null },
    );

    await expect(service.push(TENANT, ORDER_ID)).resolves.toBe('exhausted');
    expect(createOrder).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalled();
  });
});
