import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { AppLoggerService } from '../core';
import type { CustomerConsentService } from '../customer/customer-consent.service';
import type { ConversationService } from '../conversation/conversation.service';
import type { MessageTemplateService } from '../templates/message-template.service';
import { TemplateSendService } from '../templates/template-send.service';
import type { WhatsappNumberDirectory } from '../whatsapp/whatsapp-number-directory.service';
import type { BspAdapter } from '../whatsapp/ports/bsp-adapter.port';
import { TemplateReplyService } from './template-reply.service';

// F26 (D5) moved every precondition into the shared `TemplateSendService`.
// This suite builds a REAL one over the same mocks it always used, rather
// than mocking the collaborator: the behaviour under test is "does the human
// send path still refuse what it always refused", and a stubbed
// `prepare()` would assert only that this file agrees with itself.

const TENANT_A = 'tenant-a';
const CONVERSATION_ID = '11111111-2222-4333-8444-555555555555';
const TEMPLATE_ID = '22222222-2222-4333-8444-555555555555';
const USER_ID = 'user-1';
const CLIENT_ID = '99999999-2222-4333-8444-555555555555';

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_ID,
    tenantId: TENANT_A,
    customerPhone: '+8801711000001',
    channel: 'whatsapp',
    channelAccountId: 'pn-1',
    // Well outside the window — the case this whole service exists for.
    lastInboundAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    handoverState: 'agent',
    handoverAt: null,
    handoverUserId: null,
    rollingSummary: null,
    summarizedThroughMessageCount: 0,
    ...overrides,
  };
}

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    kind: 'whatsapp_template',
    name: 'order_shipped',
    language: 'en',
    category: 'UTILITY',
    body: 'Hi {{1}}, your order {{2}} shipped.',
    variables: [
      { position: 1, label: 'Name', example: null },
      { position: 2, label: 'Order', example: null },
    ],
    approvalStatus: 'approved',
    approvalDetail: null,
    syncedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeService(
  overrides: {
    conversations?: Record<string, unknown>;
    template?: Record<string, unknown>;
    optedOut?: boolean;
  } = {},
) {
  const optedOut = overrides.optedOut ?? false;
  const conversations = {
    getConversation: jest.fn().mockResolvedValue(conversation()),
    findByClientMessageId: jest.fn().mockResolvedValue(null),
    recordHumanAgentMessage: jest.fn().mockResolvedValue('message-1'),
    startHandover: jest.fn().mockResolvedValue(undefined),
    attachOutboundDelivery: jest.fn().mockResolvedValue(undefined),
    markOutboundFailed: jest.fn().mockResolvedValue(undefined),
    ...overrides.conversations,
  };
  const require_ = jest
    .fn()
    .mockResolvedValue(template(overrides.template ?? {}));
  const sendTemplateMessage = jest
    .fn()
    .mockResolvedValue({ bspMessageId: 'wamid.TEMPLATE' });
  // Nobody has opted out unless a test says so.
  const isOptedOut = jest.fn().mockResolvedValue(optedOut);
  const listForTenant = jest
    .fn()
    .mockResolvedValue([{ id: 'n1', phoneNumberId: 'pn-1' }]);

  const numbers = { listForTenant } as unknown as WhatsappNumberDirectory;
  // Default: the adapter cannot report a listing, so the pre-send WABA check
  // fails open and these tests exercise the send path itself.
  const listTemplates = jest.fn().mockResolvedValue(null);
  const bspAdapter = {
    sendTemplateMessage,
    listTemplates,
  } as unknown as BspAdapter;
  const templateSend = new TemplateSendService(
    { get: require_ } as unknown as MessageTemplateService,
    numbers,
    { isOptedOut } as unknown as CustomerConsentService,
    bspAdapter,
    { error: jest.fn(), warn: jest.fn() } as unknown as AppLoggerService,
  );

  return {
    service: new TemplateReplyService(
      conversations as unknown as ConversationService,
      templateSend,
    ),
    conversations,
    sendTemplateMessage,
    listTemplates,
    isOptedOut,
    numbers: { listForTenant },
  };
}

const input = {
  tenantId: TENANT_A,
  conversationId: CONVERSATION_ID,
  userId: USER_ID,
  templateId: TEMPLATE_ID,
  values: ['Rina', 'A-4471'],
  clientMessageId: CLIENT_ID,
};

describe('TemplateReplyService', () => {
  // ISSUE-002: a template that is `approved` here but absent on the WABA used
  // to reach Meta, fail with #132001 and come back as a 201. Now it is a clear
  // 409 before anything is recorded or sent.
  it('refuses with a 409 and records nothing when the template is not on the WABA', async () => {
    const { service, listTemplates, sendTemplateMessage, conversations } =
      makeService();
    listTemplates.mockResolvedValue([]);

    await expect(service.send(input)).rejects.toBeInstanceOf(ConflictException);

    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(conversations.recordHumanAgentMessage).not.toHaveBeenCalled();
    expect(conversations.startHandover).not.toHaveBeenCalled();
  });

  it('sends a template to a customer whose window has shut', async () => {
    const { service, sendTemplateMessage } = makeService();

    const result = await service.send(input);

    expect(sendTemplateMessage).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      to: '+8801711000001',
      templateName: 'order_shipped',
      language: 'en',
      bodyParameters: ['Rina', 'A-4471'],
    });
    expect(result.delivered).toBe(true);
    expect(result.text).toBe('Hi Rina, your order A-4471 shipped.');
  });

  it('stores the rendered text, not the raw body', async () => {
    const { service, conversations } = makeService();

    await service.send(input);

    // A transcript showing "{{1}}, your order {{2}} shipped" answers nothing
    // for the next person who opens this conversation.
    const recorded = (
      conversations.recordHumanAgentMessage as jest.Mock<
        Promise<string>,
        [{ content: string }]
      >
    ).mock.calls[0][0];
    expect(recorded.content).toBe('Hi Rina, your order A-4471 shipped.');
  });

  it('takes the conversation over so the agent does not answer on top', async () => {
    const { service, conversations } = makeService();

    await service.send(input);

    expect(conversations.startHandover).toHaveBeenCalled();
  });

  it('refuses a template WhatsApp has not approved, before reaching the BSP', async () => {
    const { service, sendTemplateMessage } = makeService({
      template: { approvalStatus: 'pending' },
    });

    await expect(service.send(input)).rejects.toBeInstanceOf(ConflictException);
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it("passes on WhatsApp's own rejection reason rather than a generic refusal", async () => {
    const { service } = makeService({
      template: {
        approvalStatus: 'rejected',
        approvalDetail: 'INVALID_FORMAT',
      },
    });

    await expect(service.send(input)).rejects.toThrow(/INVALID_FORMAT/);
  });

  it('refuses a canned reply — those only send inside the window', async () => {
    const { service, sendTemplateMessage } = makeService({
      template: { kind: 'canned_reply', approvalStatus: 'local' },
    });

    await expect(service.send(input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('refuses a value count that does not match the template', async () => {
    const { service, sendTemplateMessage } = makeService();

    await expect(
      service.send({ ...input, values: ['Rina'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Blank-filling would send "your order  shipped" and look fine to the
    // person who sent it.
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('does not reach the BSP twice for a repeated clientMessageId', async () => {
    const { service, sendTemplateMessage } = makeService({
      conversations: {
        findByClientMessageId: jest.fn().mockResolvedValue({
          id: 'message-1',
          content: 'Hi Rina, your order A-4471 shipped.',
          deliveryStatus: 'sent',
          deliveryError: null,
        }),
      },
    });

    const result = await service.send(input);

    // A template send costs the tenant money per message.
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(result.text).toBe('Hi Rina, your order A-4471 shipped.');
    expect(result.delivered).toBe(true);
  });

  it('keeps the message and marks it failed when the BSP rejects the send', async () => {
    const { service, conversations, sendTemplateMessage } = makeService();
    sendTemplateMessage.mockRejectedValue(new Error('template not found'));

    const result = await service.send(input);

    expect(result.delivered).toBe(false);
    expect(result.deliveryError).toContain('template not found');
    expect(conversations.markOutboundFailed).toHaveBeenCalled();
  });

  it('404s on a conversation belonging to another tenant', async () => {
    const { service } = makeService({
      conversations: { getConversation: jest.fn().mockResolvedValue(null) },
    });

    await expect(service.send(input)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses rather than guesses when the workspace has several numbers and the conversation predates tracking', async () => {
    const { service, numbers } = makeService({
      conversations: {
        getConversation: jest
          .fn()
          .mockResolvedValue(conversation({ channelAccountId: null })),
      },
    });
    numbers.listForTenant.mockResolvedValue([
      { id: 'n1', phoneNumberId: 'pn-1' },
      { id: 'n2', phoneNumberId: 'pn-2' },
    ]);

    await expect(service.send(input)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('TemplateReplyService.send() — consent', () => {
  // A template is business-initiated by definition: it is the one send that
  // reaches a customer who did not just message us.
  it('refuses to send a template to a customer who opted out', async () => {
    const { service, sendTemplateMessage } = makeService({ optedOut: true });

    await expect(
      service.send({
        tenantId: 'tenant-a',
        conversationId: 'conv-1',
        templateId: 'template-1',
        userId: 'agent-1',
        values: [],
        clientMessageId: 'client-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  // Refused before the message row and before handover, so a blocked send
  // leaves no trace of a conversation that never happened.
  it('records nothing and starts no handover when the send is refused', async () => {
    const { service, conversations } = makeService({ optedOut: true });

    await expect(
      service.send({
        tenantId: 'tenant-a',
        conversationId: 'conv-1',
        templateId: 'template-1',
        userId: 'agent-1',
        values: [],
        clientMessageId: 'client-1',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(conversations.recordHumanAgentMessage).not.toHaveBeenCalled();
    expect(conversations.startHandover).not.toHaveBeenCalled();
  });
});
