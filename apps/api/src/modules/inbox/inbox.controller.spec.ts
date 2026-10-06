import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { TenantAuthContext } from '../auth/jwt-claims';
import type { ConversationQueryService } from '../conversation/conversation-query.service';
import type { ConversationService } from '../conversation/conversation.service';
import type { ConversationDetail } from '../conversation/conversation-query.dto';
import { encodeCursor } from '../conversation/inbox-cursor';
import type { AnswerFeedbackService } from './answer-feedback.service';
import type { ObjectStorage } from '../storage/ports/object-storage.port';
import type { HumanReplyService } from './human-reply.service';
import type { TemplateReplyService } from './template-reply.service';
import { InboxController } from './inbox.controller';
import {
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from './inbox.dto';

const AUTH: TenantAuthContext = {
  userId: 'agent-1',
  tenantId: 'tenant-a',
  role: 'authenticated',
  appRole: 'agent',
};

const CONVERSATION_ID = '11111111-2222-4333-8444-555555555555';

function makeDetail(
  overrides: Partial<ConversationDetail> = {},
): ConversationDetail {
  return {
    id: CONVERSATION_ID,
    customerPhone: '+15550001111',
    customerName: null,
    lastInboundAt: new Date('2026-08-18T10:00:00Z'),
    rollingSummary: null,
    messageCount: 4,
    escalated: false,
    createdAt: new Date('2026-08-17T10:00:00Z'),
    channel: 'whatsapp' as const,
    handoverState: 'agent' as const,
    handoverAt: null,
    handoverUserId: null,
    replyWindow: {
      open: true,
      expiresAt: new Date('2026-08-19T10:00:00Z'),
      outOfWindowOptions: ['template'] as const,
    },
    intake: [],
    ...overrides,
  };
}

function makeController(): {
  controller: InboxController;
  conversationQuery: {
    listConversations: jest.Mock;
    getConversation: jest.Mock;
    listMessages: jest.Mock;
  };
  conversationService: { startHandover: jest.Mock; returnToAgent: jest.Mock };
  reply: jest.Mock;
  sendTemplate: jest.Mock;
} {
  const conversationQuery = {
    listConversations: jest.fn(),
    getConversation: jest.fn(),
    listMessages: jest.fn(),
  };
  const conversationService = {
    startHandover: jest.fn().mockResolvedValue(undefined),
    returnToAgent: jest.fn().mockResolvedValue(undefined),
  };

  const reply = jest.fn();
  const sendTemplate = jest.fn();

  return {
    controller: new InboxController(
      conversationQuery as unknown as ConversationQueryService,
      conversationService as unknown as ConversationService,
      { reply } as unknown as HumanReplyService,
      { send: sendTemplate } as unknown as TemplateReplyService,
      {
        rate: jest.fn(),
        clear: jest.fn(),
      } as unknown as AnswerFeedbackService,
      { download: jest.fn() } as unknown as ObjectStorage,
    ),
    conversationQuery,
    conversationService,
    reply,
    sendTemplate,
  };
}

/** The pipe runs the schema in production; parsing here keeps the coercion/default behaviour under test instead of hand-built query objects that could not occur. */
function listQuery(raw: Record<string, string> = {}) {
  return listConversationsQuerySchema.parse(raw);
}

describe('InboxController', () => {
  describe('list', () => {
    it('passes filters, page size and decoded cursor through to the query service', async () => {
      const { controller, conversationQuery } = makeController();
      const page = { items: [], nextCursor: null };
      conversationQuery.listConversations.mockResolvedValue(page);
      const cursor = encodeCursor({
        at: new Date('2026-08-18T09:00:00Z'),
        id: CONVERSATION_ID,
      });

      const result = await controller.list(
        AUTH,
        listQuery({
          limit: '10',
          cursor,
          phone: '555',
          from: '2026-08-01T00:00:00Z',
          to: '2026-08-31T00:00:00Z',
          escalated: 'true',
        }),
      );

      expect(result).toBe(page);
      expect(conversationQuery.listConversations).toHaveBeenCalledWith(
        'tenant-a',
        {
          phone: '555',
          from: new Date('2026-08-01T00:00:00Z'),
          to: new Date('2026-08-31T00:00:00Z'),
          escalated: true,
        },
        10,
        { at: new Date('2026-08-18T09:00:00Z'), id: CONVERSATION_ID },
      );
    });

    it('defaults to no cursor and the default page size', async () => {
      const { controller, conversationQuery } = makeController();
      conversationQuery.listConversations.mockResolvedValue({
        items: [],
        nextCursor: null,
      });

      await controller.list(AUTH, listQuery());

      expect(conversationQuery.listConversations).toHaveBeenCalledWith(
        'tenant-a',
        {
          phone: undefined,
          from: undefined,
          to: undefined,
          escalated: undefined,
        },
        DEFAULT_PAGE_SIZE,
        null,
      );
    });

    it('rejects a malformed cursor rather than silently restarting at page 1', () => {
      const { controller, conversationQuery } = makeController();

      expect(() =>
        controller.list(AUTH, listQuery({ cursor: 'not-a-cursor' })),
      ).toThrow(BadRequestException);
      expect(conversationQuery.listConversations).not.toHaveBeenCalled();
    });

    it('scopes the query to the caller tenant, never a client-supplied one', async () => {
      const { controller, conversationQuery } = makeController();
      conversationQuery.listConversations.mockResolvedValue({
        items: [],
        nextCursor: null,
      });

      await controller.list({ ...AUTH, tenantId: 'tenant-b' }, listQuery());

      expect(conversationQuery.listConversations).toHaveBeenCalledWith(
        'tenant-b',
        expect.anything(),
        expect.anything(),
        null,
      );
    });
  });

  describe('query schema', () => {
    it('rejects a page size above the ceiling instead of clamping — an oversized page is a client bug worth surfacing', () => {
      expect(
        listConversationsQuerySchema.safeParse({
          limit: String(MAX_PAGE_SIZE + 1),
        }).success,
      ).toBe(false);
    });

    it('rejects an inverted date range', () => {
      expect(
        listConversationsQuerySchema.safeParse({
          from: '2026-08-31T00:00:00Z',
          to: '2026-08-01T00:00:00Z',
        }).success,
      ).toBe(false);
    });

    it('reads escalated=false as a filter for never-escalated, not as "no filter"', () => {
      expect(
        listConversationsQuerySchema.parse({ escalated: 'false' }).escalated,
      ).toBe(false);
      expect(listConversationsQuerySchema.parse({}).escalated).toBeUndefined();
    });
  });

  describe('get', () => {
    it('returns the conversation detail', async () => {
      const { controller, conversationQuery } = makeController();
      const detail = makeDetail();
      conversationQuery.getConversation.mockResolvedValue(detail);

      await expect(controller.get(AUTH, CONVERSATION_ID)).resolves.toBe(detail);
      expect(conversationQuery.getConversation).toHaveBeenCalledWith(
        'tenant-a',
        CONVERSATION_ID,
      );
    });

    it('404s on an unknown id — cross-tenant ids are indistinguishable from non-existent ones', async () => {
      const { controller, conversationQuery } = makeController();
      conversationQuery.getConversation.mockResolvedValue(null);

      await expect(
        controller.get(AUTH, CONVERSATION_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('messages', () => {
    it('returns the transcript page for an existing conversation', async () => {
      const { controller, conversationQuery } = makeController();
      const page = { items: [], nextCursor: null };
      conversationQuery.getConversation.mockResolvedValue(makeDetail());
      conversationQuery.listMessages.mockResolvedValue(page);

      const result = await controller.messages(
        AUTH,
        CONVERSATION_ID,
        listMessagesQuerySchema.parse({ limit: '50' }),
      );

      expect(result).toBe(page);
      expect(conversationQuery.listMessages).toHaveBeenCalledWith(
        'tenant-a',
        CONVERSATION_ID,
        50,
        null,
      );
    });

    it('404s instead of returning an empty page when the conversation does not exist for this tenant', async () => {
      const { controller, conversationQuery } = makeController();
      conversationQuery.getConversation.mockResolvedValue(null);

      await expect(
        controller.messages(
          AUTH,
          CONVERSATION_ID,
          listMessagesQuerySchema.parse({}),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(conversationQuery.listMessages).not.toHaveBeenCalled();
    });

    it('rejects a malformed transcript cursor', async () => {
      const { controller, conversationQuery } = makeController();
      conversationQuery.getConversation.mockResolvedValue(makeDetail());

      await expect(
        controller.messages(
          AUTH,
          CONVERSATION_ID,
          listMessagesQuerySchema.parse({ cursor: 'garbage' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(conversationQuery.listMessages).not.toHaveBeenCalled();
    });
  });
});

describe('InboxController handover', () => {
  it('takes a conversation over for the calling user', async () => {
    const { controller, conversationQuery, conversationService } =
      makeController();
    conversationQuery.getConversation
      .mockResolvedValueOnce(makeDetail())
      .mockResolvedValueOnce(
        makeDetail({ handoverState: 'human', handoverUserId: 'agent-1' }),
      );

    const result = await controller.takeOver(AUTH, CONVERSATION_ID);

    expect(conversationService.startHandover).toHaveBeenCalledWith(
      'tenant-a',
      CONVERSATION_ID,
      'agent-1',
      expect.any(Date),
    );
    expect(result.handoverState).toBe('human');
  });

  it('409s when another user already holds the conversation — two owners is the failure this state exists to prevent', async () => {
    const { controller, conversationQuery, conversationService } =
      makeController();
    conversationQuery.getConversation.mockResolvedValue(
      makeDetail({ handoverState: 'human', handoverUserId: 'someone-else' }),
    );

    await expect(
      controller.takeOver(AUTH, CONVERSATION_ID),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(conversationService.startHandover).not.toHaveBeenCalled();
  });

  it('is idempotent when the caller already holds it', async () => {
    const { controller, conversationQuery, conversationService } =
      makeController();
    conversationQuery.getConversation.mockResolvedValue(
      makeDetail({ handoverState: 'human', handoverUserId: 'agent-1' }),
    );

    await controller.takeOver(AUTH, CONVERSATION_ID);

    expect(conversationService.startHandover).toHaveBeenCalled();
  });

  it('hands back to the agent, and does not fail when nobody held it', async () => {
    const { controller, conversationQuery, conversationService } =
      makeController();
    conversationQuery.getConversation.mockResolvedValue(makeDetail());

    const result = await controller.returnToAgent(AUTH, CONVERSATION_ID);

    expect(conversationService.returnToAgent).toHaveBeenCalledWith(
      'tenant-a',
      CONVERSATION_ID,
      expect.any(Date),
    );
    expect(result.handoverState).toBe('agent');
  });

  it('404s on an unknown conversation instead of creating handover state for it', async () => {
    const { controller, conversationQuery, conversationService } =
      makeController();
    conversationQuery.getConversation.mockResolvedValue(null);

    await expect(
      controller.takeOver(AUTH, CONVERSATION_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(conversationService.startHandover).not.toHaveBeenCalled();
  });
  describe('sendTemplate audit (ISSUE-002)', () => {
    const body = {
      templateId: '22222222-2222-4333-8444-555555555555',
      values: ['Faisal'],
      clientMessageId: 'client-1',
    };

    it('flags the audit entry as a failure when the BSP rejected the send', async () => {
      const { controller, sendTemplate } = makeController();
      sendTemplate.mockResolvedValue({
        messageId: 'm1',
        delivered: false,
        text: 'hi',
        deliveryError: 'WhatsApp rejected the send (#132001): nope',
      });
      const audit = { describe: jest.fn(), fail: jest.fn() };

      const result = await controller.sendTemplate(
        AUTH,
        CONVERSATION_ID,
        body,
        audit,
      );

      expect(result.delivered).toBe(false);
      expect(audit.fail).toHaveBeenCalledWith(
        'template_message.not_delivered',
        { error: 'WhatsApp rejected the send (#132001): nope' },
      );
    });

    it('leaves the audit entry a success when delivered', async () => {
      const { controller, sendTemplate } = makeController();
      sendTemplate.mockResolvedValue({
        messageId: 'm1',
        delivered: true,
        text: 'hi',
        deliveryError: null,
      });
      const audit = { describe: jest.fn(), fail: jest.fn() };

      await controller.sendTemplate(AUTH, CONVERSATION_ID, body, audit);

      expect(audit.fail).not.toHaveBeenCalled();
    });
  });
});
