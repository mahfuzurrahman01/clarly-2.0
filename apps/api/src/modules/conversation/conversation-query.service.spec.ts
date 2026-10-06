import type { TenantContextService } from '../tenant-context/tenant-context.service';
import { ChannelPolicyRegistry } from '../channel/channel-policy.registry';
import { WebChannelPolicy } from '../channel/policies/web-channel.policy';
import { WhatsappChannelPolicy } from '../channel/policies/whatsapp-channel.policy';
import {
  InstagramChannelPolicy,
  MessengerChannelPolicy,
} from '../channel/policies/meta-social-channel.policy';
import { ConversationQueryService } from './conversation-query.service';
import { decodeCursor } from './inbox-cursor';

const TENANT_A = 'tenant-a';
const CONVERSATION_A = '11111111-2222-4333-8444-555555555555';
const CONVERSATION_B = '99999999-2222-4333-8444-555555555555';

interface FakeTxCall {
  kind: 'select' | 'execute' | 'selectDistinct';
  limit?: number;
}

/**
 * Calls through to the real withTenantTx() callback against a fake tx
 * matching this service's exact chains — same rationale as
 * conversation.service.spec.ts: a mock that never invokes the callback
 * leaves the query logic (and every branch that depends on how many rows
 * came back) untested.
 */
function makeTenantContext(responses: unknown[]): {
  tenantContext: TenantContextService;
  withTenantTx: jest.Mock;
  calls: FakeTxCall[];
} {
  let call = 0;
  const calls: FakeTxCall[] = [];
  const withTenantTx = jest.fn((fn: (tx: unknown) => unknown) => {
    // Missing entries default to empty: the detail read now makes several
    // follow-up queries (intake, customer attributes, labels), and queueing
    // a response for each in every fixture would be noise.
    const response = responses[call++] ?? [];
    const selectChain = (kind: FakeTxCall['kind']) => {
      const terminal = {
        orderBy: () => ({
          limit: (limit: number) => {
            calls.push({ kind, limit });
            return Promise.resolve(response);
          },
        }),
        limit: (limit: number) => {
          calls.push({ kind, limit });
          return Promise.resolve(response);
        },
        then: (resolve: (value: unknown) => void) => {
          calls.push({ kind });
          resolve(response);
        },
      };
      return {
        from: () => ({
          leftJoin: () => ({
            leftJoin: () => ({ where: () => terminal }),
            where: () => terminal,
          }),
          // intakeFor()/intakeLabels() join through to customers and agents.
          innerJoin: () => ({ where: () => terminal, ...terminal }),
          where: () => terminal,
        }),
      };
    };

    const tx = {
      select: () => selectChain('select'),
      selectDistinct: () => selectChain('selectDistinct'),
      execute: () => {
        calls.push({ kind: 'execute' });
        return Promise.resolve({ rows: response });
      },
    };
    return fn(tx);
  });

  return {
    tenantContext: { withTenantTx } as unknown as TenantContextService,
    withTenantTx,
    calls,
  };
}

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_A,
    channel: 'whatsapp',
    customerPhone: '+15551234567',
    lastInboundAt: new Date('2026-08-18T10:00:00Z'),
    customerName: null,
    label: null,
    ...overrides,
  };
}

function aggregateRow(overrides: Record<string, unknown> = {}) {
  return {
    conversation_id: CONVERSATION_A,
    message_count: 4,
    last_role: 'assistant',
    last_content: 'Your order ships tomorrow.',
    last_created_at: '2026-08-18T10:00:05.000Z',
    ...overrides,
  };
}

/** Feature 16: the real registry — the reply window is genuinely computed, not stubbed. */
function channelPolicies(): ChannelPolicyRegistry {
  return new ChannelPolicyRegistry(
    new WhatsappChannelPolicy(),
    new MessengerChannelPolicy(),
    new InstagramChannelPolicy(),
    new WebChannelPolicy(),
  );
}

describe('ConversationQueryService.listConversations()', () => {
  it('returns a page with previews, counts and the escalation flag', async () => {
    const { tenantContext } = makeTenantContext([
      [conversationRow({ customerName: 'Ayesha' })],
      [aggregateRow()],
      [{ conversationId: CONVERSATION_A }],
    ]);
    const service = new ConversationQueryService(
      tenantContext,
      channelPolicies(),
    );

    const page = await service.listConversations(TENANT_A, {}, 25, null);

    expect(page.items).toEqual([
      {
        channel: 'whatsapp',
        id: CONVERSATION_A,
        customerPhone: '+15551234567',
        customerName: 'Ayesha',
        lastInboundAt: new Date('2026-08-18T10:00:00Z'),
        lastMessage: {
          role: 'assistant',
          content: 'Your order ships tomorrow.',
          createdAt: new Date('2026-08-18T10:00:05.000Z'),
        },
        messageCount: 4,
        escalated: true,
        label: null,
      },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('stays batched: three queries for a page, no matter how many conversations it holds', async () => {
    const rows = Array.from({ length: 25 }, (_, index) =>
      conversationRow({ id: `${index}` }),
    );
    const { tenantContext, withTenantTx } = makeTenantContext([rows, [], []]);
    const service = new ConversationQueryService(
      tenantContext,
      channelPolicies(),
    );

    await service.listConversations(TENANT_A, {}, 25, null);

    expect(withTenantTx).toHaveBeenCalledTimes(3);
  });

  it('over-fetches one row to detect a further page, and does not return that row', async () => {
    const { tenantContext, calls } = makeTenantContext([
      [
        conversationRow(),
        conversationRow({
          id: CONVERSATION_B,
          lastInboundAt: new Date('2026-08-18T09:00:00Z'),
        }),
      ],
      [],
      [],
    ]);
    const service = new ConversationQueryService(
      tenantContext,
      channelPolicies(),
    );

    const page = await service.listConversations(TENANT_A, {}, 1, null);

    expect(calls[0]).toEqual({ kind: 'select', limit: 2 });
    expect(page.items).toHaveLength(1);
    expect(decodeCursor(page.nextCursor as string)).toEqual({
      at: new Date('2026-08-18T10:00:00Z'),
      id: CONVERSATION_A,
    });
  });

  it('skips both follow-up queries entirely when the page is empty', async () => {
    const { tenantContext, withTenantTx } = makeTenantContext([[]]);
    const service = new ConversationQueryService(
      tenantContext,
      channelPolicies(),
    );

    const page = await service.listConversations(TENANT_A, {}, 25, null);

    expect(page).toEqual({ items: [], nextCursor: null });
    expect(withTenantTx).toHaveBeenCalledTimes(1);
  });

  it('reports a null preview for a conversation whose messages have been purged', async () => {
    const { tenantContext } = makeTenantContext([[conversationRow()], [], []]);
    const service = new ConversationQueryService(
      tenantContext,
      channelPolicies(),
    );

    const [item] = (await service.listConversations(TENANT_A, {}, 25, null))
      .items;

    expect(item.lastMessage).toBeNull();
    expect(item.messageCount).toBe(0);
    expect(item.escalated).toBe(false);
  });
});

describe('ConversationQueryService.getConversation()', () => {
  it('returns null for an id that is not in the caller tenant', async () => {
    const { tenantContext, withTenantTx } = makeTenantContext([[]]);
    const service = new ConversationQueryService(
      tenantContext,
      channelPolicies(),
    );

    await expect(
      service.getConversation(TENANT_A, CONVERSATION_A),
    ).resolves.toBeNull();
    expect(withTenantTx).toHaveBeenCalledTimes(1);
  });

  it('returns the thread header with the rolling summary and counts', async () => {
    const { tenantContext } = makeTenantContext([
      [
        {
          id: CONVERSATION_A,
          customerPhone: '+15551234567',
          lastInboundAt: new Date('2026-08-18T10:00:00Z'),
          channel: 'whatsapp',
          rollingSummary: 'Customer asked about delivery.',
          createdAt: new Date('2026-08-17T10:00:00Z'),
          customerName: 'Ayesha',
          handoverState: 'agent',
          handoverAt: null,
          handoverUserId: null,
        },
      ],
      [aggregateRow({ message_count: 12 })],
      [],
      [], // conversation intake
      [], // customer attributes
      [], // intake labels
    ]);
    const service = new ConversationQueryService(
      tenantContext,
      channelPolicies(),
    );

    await expect(
      service.getConversation(TENANT_A, CONVERSATION_A),
    ).resolves.toMatchObject({
      id: CONVERSATION_A,
      customerPhone: '+15551234567',
      customerName: 'Ayesha',
      lastInboundAt: new Date('2026-08-18T10:00:00Z'),
      rollingSummary: 'Customer asked about delivery.',
      messageCount: 12,
      escalated: false,
      createdAt: new Date('2026-08-17T10:00:00Z'),
      handoverState: 'agent',
    });
  });
});

describe('ConversationQueryService.listMessages()', () => {
  const newer = {
    id: CONVERSATION_A,
    role: 'assistant',
    content: 'Shipped.',
    createdAt: new Date('2026-08-18T10:00:05Z'),
    deliveryStatus: 'delivered',
    deliveryError: null,
    authorUserId: null,
    feedbackRating: null,
    feedbackNote: null,
  };
  const older = {
    id: CONVERSATION_B,
    role: 'user',
    content: 'Where is my order?',
    createdAt: new Date('2026-08-18T10:00:00Z'),
    deliveryStatus: null,
    deliveryError: null,
    authorUserId: null,
    feedbackRating: null,
    feedbackNote: null,
  };

  it('returns messages newest first with a cursor pointing at the oldest row of the page', async () => {
    const { tenantContext } = makeTenantContext([[newer, older]]);
    const service = new ConversationQueryService(
      tenantContext,
      channelPolicies(),
    );

    const page = await service.listMessages(TENANT_A, CONVERSATION_A, 1, null);

    // The mapped shape, not the raw row: feedbackRating/feedbackNote are
    // inputs from the join and are folded into a single `feedback` object.
    expect(page.items).toEqual([
      {
        id: newer.id,
        role: newer.role,
        content: newer.content,
        createdAt: newer.createdAt,
        deliveryStatus: newer.deliveryStatus,
        deliveryError: newer.deliveryError,
        authorUserId: newer.authorUserId,
        feedback: null,
        // A message with no attachment reports null rather than omitting the
        // key — the console branches on it for every bubble.
        media: null,
      },
    ]);
    expect(decodeCursor(page.nextCursor as string)).toEqual({
      at: newer.createdAt,
      id: newer.id,
    });
  });

  it('has no next cursor once the page is not full', async () => {
    const { tenantContext } = makeTenantContext([[newer, older]]);
    const service = new ConversationQueryService(
      tenantContext,
      channelPolicies(),
    );

    const page = await service.listMessages(TENANT_A, CONVERSATION_A, 50, null);

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });
});

describe('ConversationQueryService reply window', () => {
  it('reports the 24h window as shut for a conversation whose last inbound is older than a day', async () => {
    const { tenantContext } = makeTenantContext([
      [
        {
          id: CONVERSATION_A,
          channel: 'whatsapp',
          customerPhone: '+15551234567',
          // Well before any plausible "now" this test could run at.
          lastInboundAt: new Date('2020-01-01T00:00:00Z'),
          rollingSummary: null,
          createdAt: new Date('2020-01-01T00:00:00Z'),
          customerName: null,
          handoverState: 'human',
          handoverAt: new Date('2020-01-01T00:05:00Z'),
          handoverUserId: 'user-1',
        },
      ],
      [],
      [],
      [],
      [],
    ]);
    const service = new ConversationQueryService(
      tenantContext,
      channelPolicies(),
    );

    const detail = await service.getConversation(TENANT_A, CONVERSATION_A);

    expect(detail?.replyWindow).toEqual({
      channel: 'whatsapp',
      open: false,
      expiresAt: new Date('2020-01-02T00:00:00Z'),
      outOfWindowOptions: ['template'],
    });
    expect(detail?.handoverState).toBe('human');
    expect(detail?.handoverUserId).toBe('user-1');
  });
});

describe('ConversationQueryService message feedback', () => {
  it('folds a rating into the message rather than making the console fetch it separately', async () => {
    const { tenantContext } = makeTenantContext([
      [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Refunds take 5 days.',
          createdAt: new Date('2026-08-18T10:00:00Z'),
          deliveryStatus: 'delivered',
          deliveryError: null,
          authorUserId: null,
          feedbackRating: 'down',
          feedbackNote: 'Wrong window.',
        },
      ],
    ]);
    const service = new ConversationQueryService(
      tenantContext,
      channelPolicies(),
    );

    const page = await service.listMessages(TENANT_A, CONVERSATION_A, 25, null);

    expect(page.items[0].feedback).toEqual({
      rating: 'down',
      note: 'Wrong window.',
    });
  });

  it('reports no feedback as null, not as an empty rating', async () => {
    const { tenantContext } = makeTenantContext([
      [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Refunds take 5 days.',
          createdAt: new Date('2026-08-18T10:00:00Z'),
          deliveryStatus: null,
          deliveryError: null,
          authorUserId: null,
          feedbackRating: null,
          feedbackNote: null,
        },
      ],
    ]);
    const service = new ConversationQueryService(
      tenantContext,
      channelPolicies(),
    );

    const page = await service.listMessages(TENANT_A, CONVERSATION_A, 25, null);

    expect(page.items[0].feedback).toBeNull();
  });
});
