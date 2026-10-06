import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { scriptedTx } from '../../test-support/__fixtures__/scripted-tx';
import { NotificationService } from './notification.service';

const TENANT = '00000000-0000-0000-0000-00000000000a';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    tenantId: TENANT,
    kind: 'order_pending_approval',
    severity: 'warning',
    title: 'Order ORD-AV96KJ is waiting for approval',
    body: '1 item(s), 62.00 SAR, for Riazul Islam. Approve or reject it before the approval window closes.',
    params: {
      orderRef: 'ORD-AV96KJ',
      count: 1,
      total: '62.00',
      currency: 'SAR',
      customer: 'Riazul Islam',
    },
    entityType: 'order',
    entityId: '22222222-2222-2222-2222-222222222222',
    dedupKey: 'order_pending_approval:22222222-2222-2222-2222-222222222222',
    readAt: null,
    createdAt: new Date('2026-10-05T07:00:00.000Z'),
    ...overrides,
  };
}

function serviceReturning(rows: unknown[]) {
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(scriptedTx([rows]))),
  );
  return new NotificationService({
    withTenantTx,
  } as unknown as TenantContextService);
}

describe('NotificationService.list — params', () => {
  it('returns the stored params beside the English title/body', async () => {
    const [notification] = await serviceReturning([row()]).list(TENANT, {
      limit: 50,
    });

    expect(notification.params).toEqual({
      orderRef: 'ORD-AV96KJ',
      count: 1,
      total: '62.00',
      currency: 'SAR',
      customer: 'Riazul Islam',
    });
    expect(notification.title).toBe('Order ORD-AV96KJ is waiting for approval');
    expect(notification).not.toHaveProperty('dedupKey');
  });

  it('returns {} for a row written before params existed, so the console falls back to title/body', async () => {
    const [notification] = await serviceReturning([row({ params: null })]).list(
      TENANT,
      { limit: 50 },
    );

    expect(notification.params).toEqual({});
  });
});
