import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { ConversationService } from './conversation.service';

const TENANT_A = 'tenant-a';
const CONVERSATION_ID = 'conv-1';

function makeConversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_ID,
    tenantId: TENANT_A,
    customerPhone: '15551234567',
    lastInboundAt: new Date('2026-01-01T00:00:00Z'),
    rollingSummary: null,
    summarizedThroughMessageCount: 0,
    ...overrides,
  };
}

/** Calls through to the real withTenantTx() callback against a fake tx matching ConversationService's exact chains — same rationale as the F2.5/A1 specs: a mock that never invokes the callback leaves the actual query logic (and its branches) untested. */
function makeTenantContext(responses: unknown[]): {
  tenantContext: TenantContextService;
  withTenantTx: jest.Mock;
  inserted: unknown[];
  updated: unknown[];
} {
  let call = 0;
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    const response = responses[call++];
    const tx = {
      insert: () => ({
        values: (values: unknown) => {
          inserted.push(values);
          return {
            onConflictDoUpdate: () => ({
              returning: () => Promise.resolve(response),
            }),
            // recordAssistantMessage()'s chain — a plain insert that
            // returns the new row's id.
            returning: () => Promise.resolve(response),
          };
        },
      }),
      update: () => ({
        set: (values: unknown) => ({
          where: () => {
            updated.push(values);
            return {
              then: (resolve: (value: unknown) => void) => resolve(undefined),
              // applyDeliveryStatus()'s chain — reports which rows it touched.
              returning: () => Promise.resolve(response ?? []),
            };
          },
        }),
      }),
      // `where()` must work both as a directly-awaitable result
      // (getMessageCount/getConversation's simpler chains) AND as a base
      // for `.orderBy().limit()` (getRecentWindow's chain) — a thenable
      // object covers both without knowing ahead of time which chain a
      // given call will use.
      select: () => ({
        from: () => ({
          where: () => ({
            then: (resolve: (value: unknown) => void) => resolve(response),
            orderBy: () => ({
              limit: () => Promise.resolve(response),
              offset: () => Promise.resolve(response),
            }),
            limit: () => Promise.resolve(response),
          }),
        }),
      }),
    };
    return fn(tx);
  });
  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    withTenantTx,
    inserted,
    updated,
  };
}

describe('ConversationService.getOrCreateConversation()', () => {
  it('upserts and returns the conversation record', async () => {
    const row = makeConversationRow();
    const { tenantContext } = makeTenantContext([[row]]);
    const service = new ConversationService(tenantContext);

    const result = await service.getOrCreateConversation(
      TENANT_A,
      '15551234567',
    );

    expect(result).toEqual({
      id: CONVERSATION_ID,
      tenantId: TENANT_A,
      customerPhone: '15551234567',
      lastInboundAt: row.lastInboundAt,
      rollingSummary: null,
      summarizedThroughMessageCount: 0,
    });
  });
});

describe('ConversationService.recordInboundMessages()', () => {
  it('inserts one row per message and bumps lastInboundAt', async () => {
    const { tenantContext, inserted } = makeTenantContext([undefined]);
    const service = new ConversationService(tenantContext);
    const receivedAt = new Date('2026-01-02T00:00:00Z');

    await service.recordInboundMessages(
      TENANT_A,
      CONVERSATION_ID,
      [
        { providerMessageId: 'm1', text: 'hi' },
        { providerMessageId: 'm2', text: 'my order is late' },
      ],
      receivedAt,
    );

    expect(inserted).toEqual([
      [
        {
          tenantId: TENANT_A,
          conversationId: CONVERSATION_ID,
          role: 'user',
          content: 'hi',
          bspMessageId: 'm1',
          createdAt: expect.anything() as unknown,
        },
        {
          tenantId: TENANT_A,
          conversationId: CONVERSATION_ID,
          role: 'user',
          content: 'my order is late',
          bspMessageId: 'm2',
          createdAt: expect.anything() as unknown,
        },
      ],
    ]);
  });

  // Regression guard: every row of a coalesced batch used to be inserted
  // with the column default (`now()`, i.e. the TRANSACTION timestamp), so
  // all of them shared one identical created_at — and created_at is the only
  // ordering key getRecentWindow()/getMessagesAfter() have. Identical values
  // there mean the replayed transcript order (and the LIMIT 10 cut point)
  // are whatever the query plan happens to produce.
  it('gives each message in a coalesced batch a distinct, strictly increasing created_at anchored on the database clock', async () => {
    const { tenantContext, inserted } = makeTenantContext([undefined]);
    const service = new ConversationService(tenantContext);

    await service.recordInboundMessages(
      TENANT_A,
      CONVERSATION_ID,
      [
        { providerMessageId: 'm1', text: 'wrong item' },
        { providerMessageId: 'm2', text: 'I meant the blue one' },
        { providerMessageId: 'm3', text: 'sorry, size L' },
      ],
      new Date('2026-01-02T00:00:00Z'),
    );

    const rows = inserted[0] as Array<{ createdAt: unknown }>;
    const sqlOf = (row: { createdAt: unknown }) =>
      JSON.stringify(row.createdAt);

    // Distinct per row...
    expect(new Set(rows.map(sqlOf)).size).toBe(3);
    // ...and derived from the database's own now(), never the app clock, so
    // the assistant reply written a moment later (which uses the column
    // default) can never sort before this batch under clock skew.
    expect(sqlOf(rows[0])).toContain('now()');
    expect(sqlOf(rows[2])).toContain('now()');
    // The last message of the batch is the one anchored exactly at now();
    // earlier ones are offset backwards, never forwards past the reply.
    expect(sqlOf(rows[2])).toContain('0');
  });

  it('is a no-op for an empty message list', async () => {
    const { tenantContext, withTenantTx } = makeTenantContext([]);
    const service = new ConversationService(tenantContext);

    await service.recordInboundMessages(
      TENANT_A,
      CONVERSATION_ID,
      [],
      new Date(),
    );

    expect(withTenantTx).not.toHaveBeenCalled();
  });
});

describe('ConversationService.recordAssistantMessage()', () => {
  it('inserts one assistant-role row with no bspMessageId and returns its id', async () => {
    const { tenantContext, inserted } = makeTenantContext([
      [{ id: 'message-1' }],
    ]);
    const service = new ConversationService(tenantContext);

    const messageId = await service.recordAssistantMessage(
      TENANT_A,
      CONVERSATION_ID,
      'Refunds take 5 days.',
    );

    expect(messageId).toBe('message-1');
    expect(inserted).toEqual([
      {
        tenantId: TENANT_A,
        conversationId: CONVERSATION_ID,
        role: 'assistant',
        content: 'Refunds take 5 days.',
      },
    ]);
  });
});

describe('ConversationService.getRecentWindow()', () => {
  it('returns messages oldest-first even though the query fetches newest-first', async () => {
    const rows = [
      { role: 'assistant', content: 'third (newest)' },
      { role: 'user', content: 'second' },
      { role: 'user', content: 'first (oldest)' },
    ];
    const { tenantContext } = makeTenantContext([rows]);
    const service = new ConversationService(tenantContext);

    const result = await service.getRecentWindow(TENANT_A, CONVERSATION_ID);

    expect(result).toEqual([
      { role: 'user', content: 'first (oldest)' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'third (newest)' },
    ]);
  });
});

describe('ConversationService.getMessagesAfter()', () => {
  it('returns messages oldest-first, as the delta since the last summarization point', async () => {
    const rows = [
      { role: 'user', content: 'oldest new message' },
      { role: 'assistant', content: 'newest new message' },
    ];
    const { tenantContext } = makeTenantContext([rows]);
    const service = new ConversationService(tenantContext);

    const result = await service.getMessagesAfter(
      TENANT_A,
      CONVERSATION_ID,
      20,
    );

    expect(result).toEqual([
      { role: 'user', content: 'oldest new message' },
      { role: 'assistant', content: 'newest new message' },
    ]);
  });
});

describe('ConversationService.getMessageCount()', () => {
  it('returns the count from the aggregate row', async () => {
    const { tenantContext } = makeTenantContext([[{ count: 7 }]]);
    const service = new ConversationService(tenantContext);

    await expect(
      service.getMessageCount(TENANT_A, CONVERSATION_ID),
    ).resolves.toBe(7);
  });

  it('returns 0 when no row comes back', async () => {
    const { tenantContext } = makeTenantContext([[]]);
    const service = new ConversationService(tenantContext);

    await expect(
      service.getMessageCount(TENANT_A, CONVERSATION_ID),
    ).resolves.toBe(0);
  });
});

describe('ConversationService.updateSummary()', () => {
  it('writes the summary through withTenantTx, scoped to the tenant', async () => {
    const { tenantContext, withTenantTx } = makeTenantContext([undefined]);
    const service = new ConversationService(tenantContext);

    await service.updateSummary(
      TENANT_A,
      CONVERSATION_ID,
      'Customer asked about refunds.',
      12,
    );

    expect(withTenantTx).toHaveBeenCalledWith(expect.any(Function), TENANT_A);
  });
});

describe('ConversationService.getConversation()', () => {
  it('returns null when no conversation exists', async () => {
    const { tenantContext } = makeTenantContext([[]]);
    const service = new ConversationService(tenantContext);

    await expect(
      service.getConversation(TENANT_A, CONVERSATION_ID),
    ).resolves.toBeNull();
  });

  it('maps a found row to ConversationRecord', async () => {
    const row = makeConversationRow({
      rollingSummary: 'summary text',
      summarizedThroughMessageCount: 5,
    });
    const { tenantContext } = makeTenantContext([[row]]);
    const service = new ConversationService(tenantContext);

    const result = await service.getConversation(TENANT_A, CONVERSATION_ID);

    expect(result?.rollingSummary).toBe('summary text');
    expect(result?.summarizedThroughMessageCount).toBe(5);
  });
});

describe('ConversationService.applyDeliveryStatus()', () => {
  it('reports true when a stored outbound message matched the callback', async () => {
    const { tenantContext } = makeTenantContext([[{ id: 'message-1' }]]);
    const service = new ConversationService(tenantContext);

    await expect(
      service.applyDeliveryStatus(TENANT_A, 'wamid.out', 'delivered', null),
    ).resolves.toBe(true);
  });

  it('reports false for an id we never stored — Meta reports on messages outside this system, which is not an error', async () => {
    const { tenantContext } = makeTenantContext([[]]);
    const service = new ConversationService(tenantContext);

    await expect(
      service.applyDeliveryStatus(TENANT_A, 'wamid.unknown', 'read', null),
    ).resolves.toBe(false);
  });
});

describe('ConversationService handover', () => {
  it('records who took the conversation over and when', async () => {
    const { tenantContext, updated } = makeTenantContext([undefined]);
    const service = new ConversationService(tenantContext);
    const at = new Date('2026-08-18T10:00:00Z');

    await service.startHandover(TENANT_A, CONVERSATION_ID, 'user-1', at);

    expect(updated).toEqual([
      {
        handoverState: 'human',
        handoverAt: at,
        handoverUserId: 'user-1',
        handoverHoldingReplyAt: null,
        updatedAt: at,
      },
    ]);
  });

  it('clears who held it when returning to the agent, so a stale owner cannot linger on the row', async () => {
    const { tenantContext, updated } = makeTenantContext([undefined]);
    const service = new ConversationService(tenantContext);
    const at = new Date('2026-08-18T11:00:00Z');

    await service.returnToAgent(TENANT_A, CONVERSATION_ID, at);

    expect(updated).toEqual([
      {
        handoverState: 'agent',
        handoverAt: null,
        handoverUserId: null,
        handoverHoldingReplyAt: null,
        updatedAt: at,
      },
    ]);
  });

  it('records that the one holding reply of this handover was sent', async () => {
    const { tenantContext, updated } = makeTenantContext([undefined]);
    const service = new ConversationService(tenantContext);
    const at = new Date('2026-08-18T12:00:00Z');

    await service.markHandoverHoldingReplySent(TENANT_A, CONVERSATION_ID, at);

    expect(updated).toEqual([{ handoverHoldingReplyAt: at }]);
  });

  it('reports whether a human replied since the handover began', async () => {
    const { tenantContext } = makeTenantContext([[{ id: 'm1' }], []]);
    const service = new ConversationService(tenantContext);
    const since = new Date('2026-08-18T10:00:00Z');

    await expect(
      service.hasHumanReplySince(TENANT_A, CONVERSATION_ID, since),
    ).resolves.toBe(true);
    await expect(
      service.hasHumanReplySince(TENANT_A, CONVERSATION_ID, since),
    ).resolves.toBe(false);
  });
});
