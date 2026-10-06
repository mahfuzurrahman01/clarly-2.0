// F25 D9: approval, rejection, cancellation, the store-push retry and the
// expiry sweep.
//
// `withTenantTx` is stubbed to return canned rows in call order rather than
// emulating drizzle: what these tests are about is the DECISION each branch
// makes given what the database returned — in particular that zero rows from a
// conditional UPDATE is a 409 and never a silent success, and that a failure to
// TELL the customer never rolls back the decision itself.
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { AppLoggerService, Clock } from '../core';
import type { HumanReplyService } from '../inbox/human-reply.service';
import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { OrderApprovalService } from './order-approval.service';
import { InvalidOrderTransitionError } from './order-status-transition';
import type { OrderStorePushJobData } from './order-store-push.queue';
import { markEntityNotificationsRead } from '../notifications/notification-resolution';
import { scriptedTx } from '../../test-support/__fixtures__/scripted-tx';

jest.mock('../notifications/notification-resolution', () => ({
  markEntityNotificationsRead: jest.fn().mockResolvedValue(1),
}));

const TENANT = '00000000-0000-0000-0000-00000000000a';
const ORDER_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const CONVERSATION = '33333333-3333-3333-3333-333333333333';
const NOW = new Date('2026-09-22T12:00:00.000Z');

type Row = Record<string, unknown>;

function orderRow(overrides: Row = {}): Row {
  return {
    id: ORDER_ID,
    tenantId: TENANT,
    reference: 'ORD-7F3A21',
    status: 'pending_approval',
    conversationId: CONVERSATION,
    storeConnectionId: null,
    storeSyncStatus: 'not_applicable',
    total: '349.00',
    currency: 'SAR',
    customerNotifiedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeHarness(results: unknown[], replyDelivered = true) {
  const queue = [...results];
  const withTenantTx = jest.fn(() => Promise.resolve(queue.shift()));
  const reply = jest.fn().mockResolvedValue({ delivered: replyDelivered });
  const add = jest.fn().mockResolvedValue(undefined);

  const clock: Clock = { now: () => NOW, nowMs: () => NOW.getTime() };

  const service = new OrderApprovalService(
    { withTenantTx } as unknown as TenantContextService,
    { reply } as unknown as HumanReplyService,
    clock,
    {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as AppLoggerService,
    { add } as unknown as Queue<OrderStorePushJobData>,
  );

  return { service, withTenantTx, reply, add };
}

describe('OrderApprovalService.approve', () => {
  it('confirms a pending order and tells the customer through the human-reply path', async () => {
    const confirmed = orderRow({ status: 'confirmed' });
    const { service, reply } = makeHarness([
      [orderRow()], // requireOrder
      [], // findStockShortfall — nothing short
      [confirmed], // the conditional UPDATE
      [{ ...confirmed, customerNotifiedAt: NOW }], // customer_notified_at
    ]);

    await expect(
      service.approve(TENANT, ORDER_ID, USER_ID),
    ).resolves.toMatchObject({ status: 'confirmed', customerNotifiedAt: NOW });

    // One outbound message on the path a human agent's reply already takes,
    // deterministically keyed so a double-click cannot send twice.
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        conversationId: CONVERSATION,
        clientMessageId: `order-status:${ORDER_ID}:confirmed`,
      }),
    );
  });

  it('409s when the conditional UPDATE matches zero rows (D6.2 race #4)', async () => {
    const { service, reply } = makeHarness([
      [orderRow()],
      [],
      [], // somebody else decided it first
    ]);

    await expect(
      service.approve(TENANT, ORDER_ID, USER_ID),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(reply).not.toHaveBeenCalled();
  });

  it('409s, naming the item, when stock has gone since the order was placed (D2.4)', async () => {
    const { service } = makeHarness([
      [orderRow()],
      [
        {
          productName: 'Oud Perfume 50ml',
          required: 3,
          available: 1,
          isActive: true,
        },
      ],
    ]);

    await expect(service.approve(TENANT, ORDER_ID, USER_ID)).rejects.toThrow(
      /Oud Perfume 50ml has only 1 in stock/,
    );
  });

  it('approves an untracked (null stock) product that is in stock, whatever the quantity', async () => {
    const confirmed = orderRow({ status: 'confirmed' });
    const { service } = makeHarness([
      [orderRow()],
      [
        {
          productName: 'Oud Perfume 50ml',
          required: 40,
          available: null,
          stockStatus: 'in_stock',
          isActive: true,
        },
      ],
      [confirmed],
      [{ ...confirmed, customerNotifiedAt: NOW }],
    ]);

    await expect(
      service.approve(TENANT, ORDER_ID, USER_ID),
    ).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('409s an untracked product marked out of stock without quoting a count', async () => {
    const { service } = makeHarness([
      [orderRow()],
      [
        {
          productName: 'Oud Perfume 50ml',
          required: 1,
          available: null,
          stockStatus: 'out_of_stock',
          isActive: true,
        },
      ],
    ]);

    await expect(service.approve(TENANT, ORDER_ID, USER_ID)).rejects.toThrow(
      'Oud Perfume 50ml is out of stock (this order needs 1).',
    );
  });

  it('refuses to approve an order that is no longer pending, with the reason', async () => {
    const { service } = makeHarness([[orderRow({ status: 'rejected' })]]);

    await expect(
      service.approve(TENANT, ORDER_ID, USER_ID),
    ).rejects.toBeInstanceOf(InvalidOrderTransitionError);
  });

  it("404s an id this tenant cannot see — another tenant's is indistinguishable", async () => {
    const { service } = makeHarness([[]]);

    await expect(
      service.approve(TENANT, ORDER_ID, USER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('leaves the approval standing when the WhatsApp window is closed', async () => {
    const confirmed = orderRow({ status: 'confirmed' });
    const { service, reply } = makeHarness(
      [[orderRow()], [], [confirmed]],
      false,
    );
    reply.mockRejectedValue(new Error('WA_WINDOW_CLOSED'));

    const result = await service.approve(TENANT, ORDER_ID, USER_ID);

    // The decision is committed; only the telling failed. The console shows
    // "customer not notified" off this NULL.
    expect(result.status).toBe('confirmed');
    expect(result.customerNotifiedAt).toBeNull();
  });

  it('enqueues the store push, deduped on the order id, when a connection is pinned', async () => {
    const confirmed = orderRow({
      status: 'confirmed',
      storeConnectionId: 'conn-1',
      storeSyncStatus: 'pending',
    });
    const { service, add } = makeHarness([
      [orderRow({ storeConnectionId: 'conn-1' })],
      [],
      [confirmed],
      [confirmed],
    ]);

    await service.approve(TENANT, ORDER_ID, USER_ID);

    expect(add).toHaveBeenCalledWith(
      'push',
      { tenantId: TENANT, orderId: ORDER_ID },
      expect.objectContaining({ jobId: `order-store-push:${ORDER_ID}` }),
    );
  });

  it('does not enqueue anything for a tenant with no store connection (D4.3)', async () => {
    const confirmed = orderRow({ status: 'confirmed' });
    const { service, add } = makeHarness([
      [orderRow()],
      [],
      [confirmed],
      [confirmed],
    ]);

    await service.approve(TENANT, ORDER_ID, USER_ID);

    expect(add).not.toHaveBeenCalled();
  });

  it('does not roll the approval back when Redis refuses the enqueue', async () => {
    const confirmed = orderRow({
      status: 'confirmed',
      storeConnectionId: 'conn-1',
    });
    const { service, add } = makeHarness([
      [orderRow({ storeConnectionId: 'conn-1' })],
      [],
      [confirmed],
      [confirmed],
    ]);
    add.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      service.approve(TENANT, ORDER_ID, USER_ID),
    ).resolves.toMatchObject({ status: 'confirmed' });
  });
});

describe('OrderApprovalService.reject', () => {
  it('records the reason and sends the customer a NEUTRAL message, never the reason', async () => {
    const rejected = orderRow({
      status: 'rejected',
      rejectedReason: 'suspected fraud',
    });
    const { service, reply } = makeHarness([
      [orderRow()],
      [rejected],
      [rejected],
    ]);

    await service.reject(TENANT, ORDER_ID, USER_ID, 'suspected fraud');

    const sent = reply.mock.calls as Array<[{ text: string }]>;
    const sentText = sent[0]?.[0].text;
    expect(sentText).not.toContain('fraud');
    expect(sentText).toContain('ORD-7F3A21');
  });

  it('409s a second rejection', async () => {
    const { service } = makeHarness([[orderRow()], []]);

    await expect(
      service.reject(TENANT, ORDER_ID, USER_ID, 'no stock'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('OrderApprovalService.cancel', () => {
  it('cancels a confirmed order', async () => {
    const cancelled = orderRow({ status: 'cancelled' });
    const { service } = makeHarness([
      [orderRow({ status: 'confirmed' })],
      [cancelled],
      [cancelled],
    ]);

    await expect(
      service.cancel(TENANT, ORDER_ID, USER_ID),
    ).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('refuses to cancel an order that was never confirmed', async () => {
    const { service } = makeHarness([
      [orderRow({ status: 'pending_approval' })],
    ]);

    await expect(
      service.cancel(TENANT, ORDER_ID, USER_ID),
    ).rejects.toBeInstanceOf(InvalidOrderTransitionError);
  });
});

describe('OrderApprovalService.retryStorePush', () => {
  it('re-enqueues only from a failed sync, resetting the attempt counter', async () => {
    const reset = orderRow({
      status: 'confirmed',
      storeConnectionId: 'conn-1',
      storeSyncStatus: 'pending',
    });
    const { service, add } = makeHarness([
      [
        orderRow({
          status: 'confirmed',
          storeConnectionId: 'conn-1',
          storeSyncStatus: 'failed',
        }),
      ],
      [reset],
    ]);

    await service.retryStorePush(TENANT, ORDER_ID);

    expect(add).toHaveBeenCalledTimes(1);
  });

  it('409s when there is nothing to retry', async () => {
    const { service, add } = makeHarness([
      [orderRow({ status: 'confirmed', storeSyncStatus: 'synced' })],
    ]);

    await expect(
      service.retryStorePush(TENANT, ORDER_ID),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(add).not.toHaveBeenCalled();
  });
});

describe('OrderApprovalService.expireOverdue', () => {
  it('returns how many pending orders the sweep expired', async () => {
    const { service } = makeHarness([[{ id: ORDER_ID }, { id: 'other' }]]);

    await expect(service.expireOverdue(TENANT, 24)).resolves.toBe(2);
  });

  it('is a no-op when nothing is overdue', async () => {
    const { service } = makeHarness([[]]);

    await expect(service.expireOverdue(TENANT, 1)).resolves.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// QA 2026-10-05 ISSUE-012: deciding an order retires its approval prompt.
//
// These run the real `withTenantTx` callbacks against a chainable fake tx, so
// what is asserted is that the notification is retired INSIDE the transaction
// that changed the order — never as a separate write that could be lost.

function makeExecutingHarness(results: unknown[]) {
  const queue = [...results];
  const txs: unknown[] = [];
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const tx = scriptedTx(queue);
    txs.push(tx);
    return Promise.resolve(fn(tx));
  });
  const clock: Clock = { now: () => NOW, nowMs: () => NOW.getTime() };
  const service = new OrderApprovalService(
    { withTenantTx } as unknown as TenantContextService,
    {
      reply: jest.fn().mockResolvedValue({ delivered: false }),
    } as unknown as HumanReplyService,
    clock,
    {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as AppLoggerService,
    {
      add: jest.fn().mockResolvedValue(undefined),
    } as unknown as Queue<OrderStorePushJobData>,
  );
  return { service, txs };
}

describe('OrderApprovalService — retiring the approval notification', () => {
  const resolveMock = jest.mocked(markEntityNotificationsRead);

  beforeEach(() => resolveMock.mockClear());

  it('marks the order_pending_approval notification read in the approve transaction', async () => {
    const { service, txs } = makeExecutingHarness([
      [orderRow()], // requireOrder
      [], // findStockShortfall
      [orderRow({ status: 'confirmed' })], // conditional UPDATE
    ]);

    await service.approve(TENANT, ORDER_ID, USER_ID);

    expect(resolveMock).toHaveBeenCalledTimes(1);
    const [tx, input] = resolveMock.mock.calls[0];
    // The transaction that ran the conditional UPDATE, not a later one.
    expect(tx).toBe(txs[2]);
    expect(input).toEqual({
      tenantId: TENANT,
      entityType: 'order',
      entityIds: [ORDER_ID],
      kinds: ['order_pending_approval'],
      readAt: NOW,
    });
  });

  it('marks it read on rejection too', async () => {
    const { service, txs } = makeExecutingHarness([
      [orderRow()],
      [orderRow({ status: 'rejected' })],
    ]);

    await service.reject(TENANT, ORDER_ID, USER_ID, 'duplicate');

    const [tx, input] = resolveMock.mock.calls[0];
    expect(tx).toBe(txs[1]);
    expect(input).toMatchObject({
      entityIds: [ORDER_ID],
      kinds: ['order_pending_approval'],
    });
  });

  it('leaves it unread when somebody else decided the order first (409)', async () => {
    const { service } = makeExecutingHarness([[orderRow()], [], []]);

    await expect(
      service.approve(TENANT, ORDER_ID, USER_ID),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('retires the prompts of every order the expiry sweep expired, in the sweep transaction', async () => {
    const other = '44444444-4444-4444-4444-444444444444';
    const { service, txs } = makeExecutingHarness([
      [{ id: ORDER_ID }, { id: other }],
    ]);

    await expect(service.expireOverdue(TENANT, 24)).resolves.toBe(2);
    const [tx, input] = resolveMock.mock.calls[0];
    expect(tx).toBe(txs[0]);
    expect(input).toEqual({
      tenantId: TENANT,
      entityType: 'order',
      entityIds: [ORDER_ID, other],
      kinds: ['order_pending_approval'],
      readAt: NOW,
    });
  });
});
