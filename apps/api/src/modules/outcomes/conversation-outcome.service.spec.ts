import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { ConversationOutcomeService } from './conversation-outcome.service';

/**
 * The service now reads `messages` inside the same transaction to measure the
 * first response, so the fake tx answers `select()` with the next queued row
 * set: first the earliest inbound message, then the earliest reply after it.
 */
function makeTenantContext(
  selectResponses: Array<Array<{ createdAt: Date }>> = [[], []],
): {
  service: ConversationOutcomeService;
  withTenantTx: jest.Mock;
  insertedValues: () => Record<string, unknown> | undefined;
} {
  let insertedValues: Record<string, unknown> | undefined;
  const queued = [...selectResponses];
  const selectChain = (rows: Array<{ createdAt: Date }>) => {
    const node: Record<string, unknown> = {
      from: () => node,
      where: () => node,
      orderBy: () => node,
      limit: () => Promise.resolve(rows),
    };
    return node;
  };
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) =>
    fn({
      select: () => selectChain(queued.shift() ?? []),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedValues = values;
          return Promise.resolve(undefined);
        },
      }),
    }),
  );
  const tenantContext = { withTenantTx } as unknown as TenantContextService;
  return {
    service: new ConversationOutcomeService(tenantContext),
    withTenantTx,
    insertedValues: () => insertedValues,
  };
}

describe('ConversationOutcomeService.recordTicketResolved()', () => {
  it('inserts an escalated: true row with the real escalationReason and closeReason: ticket_resolved', async () => {
    const { service, withTenantTx, insertedValues } = makeTenantContext();

    await service.recordTicketResolved(
      'tenant-a',
      'conv-1',
      'CONFIDENCE_BELOW_THRESHOLD',
    );

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), 'tenant-a');
    expect(insertedValues()).toMatchObject({
      tenantId: 'tenant-a',
      conversationId: 'conv-1',
      escalated: true,
      escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
      closeReason: 'ticket_resolved',
    });
  });
});

describe('ConversationOutcomeService.recordAutoResolved()', () => {
  it('inserts an escalated: false row with a null escalationReason and closeReason: inactivity_timeout', async () => {
    const { service, insertedValues } = makeTenantContext();
    const closedAt = new Date('2026-08-13T00:00:00Z');

    await service.recordAutoResolved('tenant-a', 'conv-2', closedAt);

    expect(insertedValues()).toMatchObject({
      tenantId: 'tenant-a',
      conversationId: 'conv-2',
      escalated: false,
      escalationReason: null,
      closedAt,
      closeReason: 'inactivity_timeout',
    });
  });
});

describe('first-response measurement (Phase 5 item 1)', () => {
  const FIRST_INBOUND = new Date('2026-09-22T10:00:00.000Z');
  const FIRST_REPLY = new Date('2026-09-22T10:00:42.500Z');

  it('records the gap between the first inbound message and the first reply that followed it', async () => {
    const { service, insertedValues } = makeTenantContext([
      [{ createdAt: FIRST_INBOUND }],
      [{ createdAt: FIRST_REPLY }],
    ]);

    await service.recordAutoResolved('tenant-a', 'conv-1', new Date());

    expect(insertedValues()).toMatchObject({ firstResponseMs: 42500 });
  });

  it('records null, not 0, for a conversation that was never replied to', async () => {
    const { service, insertedValues } = makeTenantContext([
      [{ createdAt: FIRST_INBOUND }],
      [],
    ]);

    await service.recordTicketResolved('tenant-a', 'conv-1', null);

    expect(insertedValues()).toMatchObject({ firstResponseMs: null });
  });

  it('records null when there is no inbound message at all', async () => {
    const { service, insertedValues } = makeTenantContext([[], []]);

    await service.recordAutoResolved('tenant-a', 'conv-1', new Date());

    expect(insertedValues()).toMatchObject({ firstResponseMs: null });
  });
});
