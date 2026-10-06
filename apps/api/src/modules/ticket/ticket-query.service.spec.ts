import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { TicketQueryService } from './ticket-query.service';

const TENANT_A = 'tenant-a';

function makeTicketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ticket-1',
    tenantId: TENANT_A,
    customerId: 'customer-1',
    conversationId: 'conv-1',
    escalationReason: 'CONFIDENCE_BELOW_THRESHOLD',
    status: 'OPEN',
    note: null,
    assigneeId: null,
    confidence: 0.4,
    citedChunkIds: ['chunk-1'],
    claimedAt: null,
    resolvedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Two-call harness: first withTenantTx() call is the tickets+customers join, second is the batched messages query. Verifies the "2 queries, never N+1" contract directly via withTenantTx's own call count. */
function makeTenantContext(
  joinRows: Array<{
    ticket: unknown;
    customerPhone: string;
    customerName: string | null;
    // Feature 18: joined in from `customer_labels` on the same query, so the
    // board never pays a round trip per card for it.
    customerLabel?: string | null;
    customerLabelOverriddenAt?: Date | null;
  }>,
  messageRows: Array<{
    conversationId: string;
    role: string;
    content: string;
  }> = [],
): { tenantContext: TenantContextService; withTenantTx: jest.Mock } {
  let call = 0;
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const thisCall = call++;
    const tx = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            // Feature 18's label join — still the SAME query, so the "2
            // queries, never N+1" contract this harness exists to check is
            // unchanged.
            leftJoin: () => ({
              where: () => ({
                orderBy: () => Promise.resolve(joinRows),
                limit: () => Promise.resolve(joinRows),
              }),
            }),
          }),
          where: () => ({ orderBy: () => Promise.resolve(messageRows) }),
        }),
      }),
    };
    void thisCall;
    return fn(tx);
  });
  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    withTenantTx,
  };
}

describe('TicketQueryService.listWithContext()', () => {
  it('attaches customer info and the transcript, using exactly 2 queries regardless of ticket count (T8)', async () => {
    const rows = [
      {
        ticket: makeTicketRow({ id: 'ticket-1', conversationId: 'conv-1' }),
        customerPhone: '155',
        customerName: 'Jane',
      },
      {
        ticket: makeTicketRow({ id: 'ticket-2', conversationId: 'conv-2' }),
        customerPhone: '156',
        customerName: null,
      },
    ];
    const messageRows = [
      { conversationId: 'conv-1', role: 'user', content: 'hi' },
      {
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'hello, how can I help?',
      },
      { conversationId: 'conv-2', role: 'user', content: 'help' },
    ];
    const { tenantContext, withTenantTx } = makeTenantContext(
      rows,
      messageRows,
    );
    const service = new TicketQueryService(tenantContext);

    const results = await service.listWithContext(TENANT_A);

    expect(withTenantTx).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0]?.customerName).toBe('Jane');
    expect(results[0]?.transcript).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello, how can I help?' },
    ]);
    expect(results[1]?.transcript).toEqual([{ role: 'user', content: 'help' }]);
  });

  it('confidence and citedChunkIds come from the ticket row itself, not a second query', async () => {
    const rows = [
      {
        ticket: makeTicketRow({ confidence: 0.85, citedChunkIds: ['chunk-9'] }),
        customerPhone: '155',
        customerName: null,
      },
    ];
    const { tenantContext } = makeTenantContext(rows, []);
    const service = new TicketQueryService(tenantContext);

    const results = await service.listWithContext(TENANT_A);

    expect(results[0]?.confidence).toBe(0.85);
    expect(results[0]?.citedChunkIds).toEqual(['chunk-9']);
  });

  it('skips the messages query entirely when no ticket has a conversationId', async () => {
    const rows = [
      {
        ticket: makeTicketRow({ conversationId: null }),
        customerPhone: '155',
        customerName: null,
      },
    ];
    const { tenantContext, withTenantTx } = makeTenantContext(rows, []);
    const service = new TicketQueryService(tenantContext);

    const results = await service.listWithContext(TENANT_A);

    expect(withTenantTx).toHaveBeenCalledTimes(1);
    expect(results[0]?.transcript).toEqual([]);
  });

  it('caps the transcript at the last 10 messages per conversation', async () => {
    const rows = [
      {
        ticket: makeTicketRow({ conversationId: 'conv-1' }),
        customerPhone: '155',
        customerName: null,
      },
    ];
    const messageRows = Array.from({ length: 15 }, (_, i) => ({
      conversationId: 'conv-1',
      role: 'user',
      content: `message ${i}`,
    }));
    const { tenantContext } = makeTenantContext(rows, messageRows);
    const service = new TicketQueryService(tenantContext);

    const results = await service.listWithContext(TENANT_A);

    expect(results[0]?.transcript).toHaveLength(10);
    expect(results[0]?.transcript[0]?.content).toBe('message 5');
  });
});

describe('TicketQueryService.getWithContext()', () => {
  it('returns null when no ticket matches', async () => {
    const { tenantContext } = makeTenantContext([], []);
    const service = new TicketQueryService(tenantContext);

    await expect(
      service.getWithContext(TENANT_A, 'nonexistent'),
    ).resolves.toBeNull();
  });

  it('returns the single ticket with its transcript', async () => {
    const rows = [
      { ticket: makeTicketRow(), customerPhone: '155', customerName: 'Jane' },
    ];
    const messageRows = [
      { conversationId: 'conv-1', role: 'user', content: 'hi' },
    ];
    const { tenantContext } = makeTenantContext(rows, messageRows);
    const service = new TicketQueryService(tenantContext);

    const result = await service.getWithContext(TENANT_A, 'ticket-1');

    expect(result?.id).toBe('ticket-1');
    expect(result?.transcript).toEqual([{ role: 'user', content: 'hi' }]);
  });
});

describe('TicketQueryService customer labels (Feature 18)', () => {
  it('carries the label on the ticket card, marked agent-sourced when nobody has overridden it', async () => {
    const { tenantContext, withTenantTx } = makeTenantContext([
      {
        ticket: makeTicketRow({ conversationId: null }),
        customerPhone: '155',
        customerName: 'Jane',
        customerLabel: 'hot',
        customerLabelOverriddenAt: null,
      },
    ]);
    const service = new TicketQueryService(tenantContext);

    const [result] = await service.listWithContext(TENANT_A);

    expect(result).toMatchObject({
      customerLabel: 'hot',
      customerLabelSource: 'agent',
    });
    // Still the same single join query — no extra round trip for the label.
    expect(withTenantTx).toHaveBeenCalledTimes(1);
  });

  it('marks a label a human overrode as human-sourced, so the board can show it was corrected', async () => {
    const { tenantContext } = makeTenantContext([
      {
        ticket: makeTicketRow({ conversationId: null }),
        customerPhone: '155',
        customerName: 'Jane',
        customerLabel: 'vip',
        customerLabelOverriddenAt: new Date('2026-02-02T00:00:00Z'),
      },
    ]);
    const service = new TicketQueryService(tenantContext);

    const [result] = await service.listWithContext(TENANT_A);

    expect(result).toMatchObject({
      customerLabel: 'vip',
      customerLabelSource: 'human',
    });
  });

  it('reports an unlabelled customer as null on BOTH fields, never a defaulted source', async () => {
    const { tenantContext } = makeTenantContext([
      {
        ticket: makeTicketRow({ conversationId: null }),
        customerPhone: '155',
        customerName: 'Jane',
        customerLabel: null,
        customerLabelOverriddenAt: null,
      },
    ]);
    const service = new TicketQueryService(tenantContext);

    const [result] = await service.listWithContext(TENANT_A);

    expect(result?.customerLabel).toBeNull();
    expect(result?.customerLabelSource).toBeNull();
  });
});
