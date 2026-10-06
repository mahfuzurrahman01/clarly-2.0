import type { ConversationService } from '../conversation/conversation.service';
import type { CustomerLabelService } from '../customer/customer-label.service';
import type { CustomerService } from '../customer/customer.service';
import type { CommentLedgerService } from './comment-ledger.service';
import { CommentThreadService } from './comment-thread.service';

describe('CommentThreadService (D15b)', () => {
  const dm = {
    tenantId: 't1',
    channel: 'instagram' as const,
    channelAccountId: 'ig-1',
    from: 'IGSID-1',
  };

  function build(threads: Record<string, unknown>[]) {
    const ledger = {
      adoptAwaitingThreads: jest.fn().mockResolvedValue(threads),
      linkConversation: jest.fn().mockResolvedValue(undefined),
    };
    const customers = {
      getOrCreateByPhone: jest.fn().mockResolvedValue({ id: 'cust-1' }),
    };
    const conversations = {
      getOrCreateConversation: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      recordAssistantMessage: jest.fn().mockResolvedValue('msg-1'),
      attachOutboundDelivery: jest.fn().mockResolvedValue(undefined),
    };
    const labels = { applyAgentLabel: jest.fn().mockResolvedValue({}) };
    const service = new CommentThreadService(
      ledger as unknown as CommentLedgerService,
      customers as unknown as CustomerService,
      conversations as unknown as ConversationService,
      labels as unknown as CustomerLabelService,
    );
    return { service, ledger, customers, conversations, labels };
  }

  it('opens nothing when no private reply is waiting on the sender', async () => {
    const { service, customers, conversations } = build([]);
    await expect(service.adoptOnCustomerMessage(dm)).resolves.toBeNull();
    expect(customers.getOrCreateByPhone).not.toHaveBeenCalled();
    expect(conversations.getOrCreateConversation).not.toHaveBeenCalled();
  });

  it('never looks for threads on WhatsApp', async () => {
    const { service, ledger } = build([]);
    await service.adoptOnCustomerMessage({ ...dm, channel: 'whatsapp' });
    expect(ledger.adoptAwaitingThreads).not.toHaveBeenCalled();
  });

  it('opens the conversation with our private reply as its first agent message, then labels the customer', async () => {
    const { service, ledger, customers, conversations, labels } = build([
      {
        id: 'evt-1',
        intent: 'purchase',
        privateReplyText: 'The abaya is 250 SAR.',
        privateReplyMessageId: 'mid.pr1',
      },
    ]);

    await expect(service.adoptOnCustomerMessage(dm)).resolves.toEqual({
      conversationId: 'conv-1',
      commentEventIds: ['evt-1'],
    });

    expect(ledger.adoptAwaitingThreads).toHaveBeenCalledWith(
      't1',
      'ig-1',
      'IGSID-1',
    );
    expect(customers.getOrCreateByPhone).toHaveBeenCalledWith(
      't1',
      'IGSID-1',
      'instagram',
    );
    expect(conversations.getOrCreateConversation).toHaveBeenCalledWith(
      't1',
      'IGSID-1',
      'ig-1',
      'instagram',
    );
    expect(conversations.recordAssistantMessage).toHaveBeenCalledWith(
      't1',
      'conv-1',
      'The abaya is 250 SAR.',
    );
    expect(conversations.attachOutboundDelivery).toHaveBeenCalledWith(
      't1',
      'msg-1',
      'mid.pr1',
    );
    expect(ledger.linkConversation).toHaveBeenCalledWith(
      't1',
      ['evt-1'],
      'conv-1',
    );
    expect(labels.applyAgentLabel).toHaveBeenCalledWith('t1', 'cust-1', 'hot');
  });

  it('uses the strongest label when several comments led to the same DM', async () => {
    const { service, labels } = build([
      { id: 'a', intent: 'question', privateReplyText: 'x' },
      { id: 'b', intent: 'purchase', privateReplyText: 'y' },
    ]);
    await service.adoptOnCustomerMessage(dm);
    expect(labels.applyAgentLabel).toHaveBeenCalledWith('t1', 'cust-1', 'hot');
  });

  it('writes no label when the intent says nothing about the customer', async () => {
    const { service, labels } = build([
      { id: 'a', intent: 'other', privateReplyText: 'x' },
    ]);
    await service.adoptOnCustomerMessage(dm);
    expect(labels.applyAgentLabel).not.toHaveBeenCalled();
  });
});
