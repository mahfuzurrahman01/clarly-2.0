import { ConflictException, NotFoundException } from '@nestjs/common';
import type { AppLoggerService } from '../core';
import type { ConversationService } from '../conversation/conversation.service';
import type { ConversationQueryService } from '../conversation/conversation-query.service';
import type { WhatsappNumberDirectory } from '../whatsapp/whatsapp-number-directory.service';
import type { ChannelRegistry } from '../channel/channel-registry.service';
import { ChannelPolicyRegistry } from '../channel/channel-policy.registry';
import { WebChannelPolicy } from '../channel/policies/web-channel.policy';
import { WhatsappChannelPolicy } from '../channel/policies/whatsapp-channel.policy';
import {
  InstagramChannelPolicy,
  MessengerChannelPolicy,
} from '../channel/policies/meta-social-channel.policy';
import { HumanReplyService } from './human-reply.service';

const TENANT_A = 'tenant-a';
const CONVERSATION_ID = '11111111-2222-4333-8444-555555555555';
const USER_ID = 'user-1';
const CLIENT_ID = '99999999-2222-4333-8444-555555555555';

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_ID,
    tenantId: TENANT_A,
    customerPhone: '+8801711000001',
    channel: 'whatsapp',
    channelAccountId: 'pn-1',
    // Inside the 24-hour window unless a test moves it.
    lastInboundAt: new Date(Date.now() - 60_000),
    handoverState: 'agent',
    handoverAt: null,
    handoverUserId: null,
    rollingSummary: null,
    summarizedThroughMessageCount: 0,
    ...overrides,
  };
}

function makeService(overrides: Record<string, unknown> = {}) {
  const conversations = {
    getConversation: jest.fn().mockResolvedValue(conversation()),
    findByClientMessageId: jest.fn().mockResolvedValue(null),
    recordHumanAgentMessage: jest.fn().mockResolvedValue('message-1'),
    startHandover: jest.fn().mockResolvedValue(undefined),
    attachOutboundDelivery: jest.fn().mockResolvedValue(undefined),
    markOutboundFailed: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const sendText = jest
    .fn()
    .mockResolvedValue({ providerMessageId: 'wamid.OUT' });
  const listForTenant = jest
    .fn()
    .mockResolvedValue([{ id: 'n1', phoneNumberId: 'pn-1' }]);
  const error = jest.fn();

  return {
    service: new HumanReplyService(
      conversations as unknown as ConversationService,
      {} as unknown as ConversationQueryService,
      { listForTenant } as unknown as WhatsappNumberDirectory,
      {
        for: jest.fn().mockReturnValue({ sendText }),
      } as unknown as ChannelRegistry,
      new ChannelPolicyRegistry(
        new WhatsappChannelPolicy(),
        new MessengerChannelPolicy(),
        new InstagramChannelPolicy(),
        new WebChannelPolicy(),
      ),
      { error } as unknown as AppLoggerService,
    ),
    conversations,
    sendText,
    listForTenant,
  };
}

const REPLY = {
  tenantId: TENANT_A,
  conversationId: CONVERSATION_ID,
  userId: USER_ID,
  text: 'We have refunded you today.',
  clientMessageId: CLIENT_ID,
};

describe('HumanReplyService.reply()', () => {
  it('stores the reply as human_agent, takes the conversation over, and sends it', async () => {
    const { service, conversations, sendText } = makeService();

    const result = await service.reply(REPLY);

    expect(conversations.recordHumanAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'We have refunded you today.',
        authorUserId: USER_ID,
        clientMessageId: CLIENT_ID,
      }),
    );
    // Without this the agent answers over the person on the customer's very
    // next message.
    expect(conversations.startHandover).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith({
      channelAccountId: 'pn-1',
      to: '+8801711000001',
      body: 'We have refunded you today.',
    });
    expect(result).toEqual({
      messageId: 'message-1',
      delivered: true,
      deliveryError: null,
    });
  });

  it('takes the conversation over BEFORE the send, since the customer can reply the instant it lands', async () => {
    const order: string[] = [];
    const { service, conversations, sendText } = makeService();
    conversations.startHandover.mockImplementation(() => {
      order.push('handover');
      return Promise.resolve();
    });
    sendText.mockImplementation(() => {
      order.push('send');
      return Promise.resolve({ bspMessageId: 'wamid.OUT' });
    });

    await service.reply(REPLY);

    expect(order).toEqual(['handover', 'send']);
  });

  it('refuses to send outside the 24-hour window rather than letting Meta reject it silently', async () => {
    const { service, conversations, sendText } = makeService({
      getConversation: jest.fn().mockResolvedValue(
        conversation({
          lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        }),
      ),
    });

    await expect(service.reply(REPLY)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(sendText).not.toHaveBeenCalled();
    expect(conversations.recordHumanAgentMessage).not.toHaveBeenCalled();
  });

  it('is idempotent: the same clientMessageId returns the first result without messaging the customer again', async () => {
    const { service, conversations, sendText } = makeService({
      findByClientMessageId: jest.fn().mockResolvedValue({
        id: 'message-1',
        deliveryStatus: 'sent',
        deliveryError: null,
      }),
    });

    const result = await service.reply(REPLY);

    expect(result.messageId).toBe('message-1');
    expect(sendText).not.toHaveBeenCalled();
    expect(conversations.recordHumanAgentMessage).not.toHaveBeenCalled();
    expect(conversations.startHandover).not.toHaveBeenCalled();
  });

  it('keeps the message and marks it undelivered when the BSP rejects it, instead of losing what the agent typed', async () => {
    const { service, conversations, sendText } = makeService();
    sendText.mockRejectedValue(new Error('Meta 401'));

    const result = await service.reply(REPLY);

    expect(result).toEqual({
      messageId: 'message-1',
      delivered: false,
      deliveryError: 'Meta 401',
    });
    expect(conversations.markOutboundFailed).toHaveBeenCalledWith(
      TENANT_A,
      'message-1',
      'Meta 401',
    );
  });

  it("falls back to the workspace's only number for a conversation recorded before numbers were tracked", async () => {
    const { service, sendText } = makeService({
      getConversation: jest
        .fn()
        .mockResolvedValue(conversation({ channelAccountId: null })),
    });

    await service.reply(REPLY);

    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({ channelAccountId: 'pn-1' }),
    );
  });

  it('refuses rather than guessing when an untracked conversation could be answered from several numbers', async () => {
    const { service, listForTenant, sendText } = makeService({
      getConversation: jest
        .fn()
        .mockResolvedValue(conversation({ channelAccountId: null })),
    });
    listForTenant.mockResolvedValue([
      { id: 'n1', phoneNumberId: 'pn-1' },
      { id: 'n2', phoneNumberId: 'pn-2' },
    ]);

    await expect(service.reply(REPLY)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it("404s for another tenant's conversation before touching anything", async () => {
    const { service, conversations, sendText } = makeService({
      getConversation: jest.fn().mockResolvedValue(null),
    });

    await expect(service.reply(REPLY)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(conversations.recordHumanAgentMessage).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });
});
