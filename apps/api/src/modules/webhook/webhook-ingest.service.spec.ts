import type { CampaignDeliveryTracker } from '../campaign/campaign-delivery.tracker';
import type { CommentThreadService } from '../comments/comment-thread.service';
import type {
  ChannelAdapter,
  NormalizedOutboundEcho,
  NormalizedStatusUpdate,
  NormalizedInboundMessage,
} from '../channel/ports/channel-adapter.port';
import type { ConversationService } from '../conversation/conversation.service';
import type { CustomerConsentService } from '../customer/customer-consent.service';
import type { CustomerService } from '../customer/customer.service';
import type { TenantStatusService } from '../tenant-context/tenant-status.service';
import type { TicketEscalationService } from '../ticket/ticket-escalation.service';
import type { MediaIntakeService } from './media-intake.service';
import type { RespondPathProducerService } from './respond-path-producer.service';
import type { WebhookDedupService } from './webhook-dedup.service';
import type { WebhookRateLimiterService } from './webhook-rate-limiter.service';
import type { ChannelTenantResolver } from './channel-tenant-resolver.service';
import {
  WebhookIngestService,
  WebhookSignatureVerificationError,
} from './webhook-ingest.service';
import { UnknownChannelAccountError } from './channel-tenant-resolver.service';

function makeMessage(
  overrides: Partial<NormalizedInboundMessage> = {},
): NormalizedInboundMessage {
  return {
    channel: 'whatsapp',
    channelAccountId: 'pn-1',
    providerMessageId: 'wamid.1',
    from: '15551234567',
    type: 'text',
    text: 'hello',
    receivedAt: new Date(),
    ...overrides,
  };
}

function makeAdapter(
  messages: NormalizedInboundMessage[],
  verifies = true,
  statusUpdates: NormalizedStatusUpdate[] = [],
  echoes: NormalizedOutboundEcho[] = [],
): ChannelAdapter {
  return {
    channel: 'whatsapp',
    verifyWebhookSignature: jest.fn().mockReturnValue(verifies),
    parseInboundWebhook: jest.fn().mockReturnValue(messages),
    parseStatusUpdates: jest.fn().mockReturnValue(statusUpdates),
    parseOutboundEchoes: jest.fn().mockReturnValue(echoes),
    sendText: jest.fn(),
    verifySubscription: jest.fn().mockReturnValue(null),
  } as unknown as ChannelAdapter;
}

/** Raw mock fns, kept separate from the typed service objects below so assertions never go through a typed-interface property access (triggers @typescript-eslint/unbound-method). */
interface Mocks {
  resolveTenantId: jest.Mock;
  isClosed: jest.Mock;
  allow: jest.Mock;
  checkAndRecord: jest.Mock;
  enqueue: jest.Mock;
  createTicket: jest.Mock;
  getOrCreateByPhone: jest.Mock;
  getOrCreateConversation: jest.Mock;
  applyDeliveryStatus: jest.Mock;
  recordMedia: jest.Mock;
  isOptedOut: jest.Mock;
  recordOptOut: jest.Mock;
  recordOptIn: jest.Mock;
  recordBusinessAppEcho: jest.Mock;
  startHandover: jest.Mock;
  adoptOnCustomerMessage: jest.Mock;
  applyCampaignDelivery: jest.Mock;
  attributeCampaignReply: jest.Mock;
}

function makeMocks(overrides: Partial<Mocks> = {}): Mocks {
  return {
    resolveTenantId: jest.fn().mockResolvedValue('tenant-a'),
    // The workspace is open unless a test closes it.
    isClosed: jest.fn().mockResolvedValue(false),
    allow: jest.fn().mockResolvedValue(true),
    checkAndRecord: jest.fn().mockResolvedValue({ isDuplicate: false }),
    enqueue: jest.fn().mockResolvedValue(undefined),
    createTicket: jest.fn().mockResolvedValue({}),
    getOrCreateByPhone: jest.fn().mockResolvedValue({ id: 'customer-1' }),
    getOrCreateConversation: jest.fn().mockResolvedValue({ id: 'conv-1' }),
    applyDeliveryStatus: jest.fn().mockResolvedValue(true),
    // F17: record() reports whether the download was actually queued, not just
    // which row it wrote — see MediaIntakeService.
    recordMedia: jest
      .fn()
      .mockResolvedValue({ messageId: 'message-1', queued: true }),
    // Nobody has opted out unless a test says so.
    isOptedOut: jest.fn().mockResolvedValue(false),
    recordOptOut: jest.fn().mockResolvedValue({}),
    recordOptIn: jest.fn().mockResolvedValue({}),
    recordBusinessAppEcho: jest.fn().mockResolvedValue('message-echo-1'),
    startHandover: jest.fn().mockResolvedValue(undefined),
    // Gulf T8 (D15b): no private reply is waiting unless a test says so.
    adoptOnCustomerMessage: jest.fn().mockResolvedValue(null),
    // F19 (D5): most outbound messages are not campaign messages, so the
    // tracker's honest default is "this id belongs to no campaign".
    applyCampaignDelivery: jest.fn().mockResolvedValue(false),
    attributeCampaignReply: jest.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function makeService(mocks: Mocks): WebhookIngestService {
  return new WebhookIngestService(
    {
      resolveTenantId: mocks.resolveTenantId,
    } as unknown as ChannelTenantResolver,
    { isClosed: mocks.isClosed } as unknown as TenantStatusService,
    { allow: mocks.allow } as unknown as WebhookRateLimiterService,
    { checkAndRecord: mocks.checkAndRecord } as unknown as WebhookDedupService,
    { enqueue: mocks.enqueue } as unknown as RespondPathProducerService,
    { createTicket: mocks.createTicket } as unknown as TicketEscalationService,
    {
      getOrCreateByPhone: mocks.getOrCreateByPhone,
    } as unknown as CustomerService,
    {
      isOptedOut: mocks.isOptedOut,
      recordOptOut: mocks.recordOptOut,
      recordOptIn: mocks.recordOptIn,
    } as unknown as CustomerConsentService,
    {
      getOrCreateConversation: mocks.getOrCreateConversation,
      applyDeliveryStatus: mocks.applyDeliveryStatus,
      recordBusinessAppEcho: mocks.recordBusinessAppEcho,
      startHandover: mocks.startHandover,
    } as unknown as ConversationService,
    { record: mocks.recordMedia } as unknown as MediaIntakeService,
    {
      adoptOnCustomerMessage: mocks.adoptOnCustomerMessage,
    } as unknown as CommentThreadService,
    {
      apply: mocks.applyCampaignDelivery,
      attributeReplyFromPhone: mocks.attributeCampaignReply,
    } as unknown as CampaignDeliveryTracker,
  );
}

describe('WebhookIngestService.ingest()', () => {
  it('throws WebhookSignatureVerificationError and does nothing else when the signature is invalid', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);
    const adapter = makeAdapter([makeMessage()], false);

    await expect(service.ingest(adapter, '{}', {})).rejects.toBeInstanceOf(
      WebhookSignatureVerificationError,
    );
    expect(mocks.resolveTenantId).not.toHaveBeenCalled();
  });

  it('enqueues a text message to the respond-path queue after tenant resolution and dedup', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);
    const adapter = makeAdapter([makeMessage()]);

    const results = await service.ingest(adapter, '{}', {});

    expect(results).toEqual([
      { providerMessageId: 'wamid.1', outcome: 'enqueued' },
    ]);
    expect(mocks.enqueue).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      channel: 'whatsapp',
      channelAccountId: 'pn-1',
      providerMessageId: 'wamid.1',
      from: '15551234567',
      text: 'hello',
    });
  });

  it('propagates UnknownChannelAccountError for a webhook on an unrecognized phone_number_id', async () => {
    const mocks = makeMocks({
      resolveTenantId: jest
        .fn()
        .mockRejectedValue(new UnknownChannelAccountError('whatsapp', 'pn-1')),
    });
    const service = makeService(mocks);
    const adapter = makeAdapter([makeMessage()]);

    await expect(service.ingest(adapter, '{}', {})).rejects.toBeInstanceOf(
      UnknownChannelAccountError,
    );
  });

  it('marks a rate-limited message as rate_limited and never touches dedup/enqueue for it', async () => {
    const mocks = makeMocks({ allow: jest.fn().mockResolvedValue(false) });
    const service = makeService(mocks);
    const adapter = makeAdapter([makeMessage()]);

    const results = await service.ingest(adapter, '{}', {});

    expect(results).toEqual([
      { providerMessageId: 'wamid.1', outcome: 'rate_limited' },
    ]);
    expect(mocks.checkAndRecord).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  // TenantAuthMiddleware gates every authenticated route on closure, but
  // the BSP webhook is unauthenticated and never passes through it. Without
  // this check a closed workspace keeps answering customers, keeps spending
  // on LLM turns, and keeps writing personal data into a workspace already
  // scheduled for erasure.
  it('drops an inbound message for a closed workspace before recording anything', async () => {
    const mocks = makeMocks({ isClosed: jest.fn().mockResolvedValue(true) });
    const service = makeService(mocks);
    const adapter = makeAdapter([makeMessage()]);

    const results = await service.ingest(adapter, '{}', {});

    expect(results).toEqual([
      { providerMessageId: 'wamid.1', outcome: 'workspace_closed' },
    ]);
    expect(mocks.allow).not.toHaveBeenCalled();
    expect(mocks.checkAndRecord).not.toHaveBeenCalled();
    expect(mocks.getOrCreateByPhone).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('marks a replayed message as duplicate and never re-enqueues it (T6 replay-once guarantee)', async () => {
    const mocks = makeMocks({
      checkAndRecord: jest.fn().mockResolvedValue({ isDuplicate: true }),
    });
    const service = makeService(mocks);
    const adapter = makeAdapter([makeMessage()]);

    const results = await service.ingest(adapter, '{}', {});

    expect(results).toEqual([
      { providerMessageId: 'wamid.1', outcome: 'duplicate' },
    ]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('Gulf T8 (D15b): lets a waiting comment private-reply thread adopt the DM before it is answered', async () => {
    const mocks = makeMocks({
      adoptOnCustomerMessage: jest.fn().mockResolvedValue({
        conversationId: 'conv-1',
        commentEventIds: ['e'],
      }),
    });
    const service = makeService(mocks);
    const adapter = makeAdapter([
      makeMessage({
        channel: 'instagram',
        channelAccountId: 'ig-1',
        from: 'IGSID-1',
        providerMessageId: 'mid.1',
      }),
    ]);

    const results = await service.ingest(adapter, '{}', {});

    expect(mocks.adoptOnCustomerMessage).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      channel: 'instagram',
      channelAccountId: 'ig-1',
      from: 'IGSID-1',
    });
    // The DM then continues down the normal respond path.
    expect(results).toEqual([
      { providerMessageId: 'mid.1', outcome: 'enqueued' },
    ]);
    expect(
      mocks.adoptOnCustomerMessage.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.enqueue.mock.invocationCallOrder[0]);
  });

  it('Gulf T8 (D15b): a replayed DM never re-adopts a thread', async () => {
    const mocks = makeMocks({
      checkAndRecord: jest.fn().mockResolvedValue({ isDuplicate: true }),
    });
    const service = makeService(mocks);
    await service.ingest(makeAdapter([makeMessage()]), '{}', {});
    expect(mocks.adoptOnCustomerMessage).not.toHaveBeenCalled();
  });

  it('escalates an unsupported media message to a ticket instead of enqueueing it (T3)', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);
    const adapter = makeAdapter([
      makeMessage({ type: 'image', text: undefined }),
    ]);

    const results = await service.ingest(adapter, '{}', {});

    expect(results).toEqual([
      { providerMessageId: 'wamid.1', outcome: 'escalated_unsupported_media' },
    ]);
    expect(mocks.createTicket).toHaveBeenCalledTimes(1);
    const [createTicketArgs] = mocks.createTicket.mock.calls[0] as [
      {
        tenantId: string;
        customerId: string;
        conversationId: string;
        escalationReason: string;
        note: string;
      },
    ];
    expect(createTicketArgs.tenantId).toBe('tenant-a');
    expect(createTicketArgs.customerId).toBe('customer-1');
    expect(createTicketArgs.conversationId).toBe('conv-1');
    expect(createTicketArgs.escalationReason).toBe('UNSUPPORTED_MEDIA');
    expect(createTicketArgs.note).toContain('image');
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('processes a batch of messages independently — one duplicate does not block the others', async () => {
    const checkAndRecord = jest
      .fn()
      .mockResolvedValueOnce({ isDuplicate: false })
      .mockResolvedValueOnce({ isDuplicate: true });
    const mocks = makeMocks({ checkAndRecord });
    const service = makeService(mocks);
    const adapter = makeAdapter([
      makeMessage({ providerMessageId: 'wamid.1' }),
      makeMessage({ providerMessageId: 'wamid.2' }),
    ]);

    const results = await service.ingest(adapter, '{}', {});

    expect(results).toEqual([
      { providerMessageId: 'wamid.1', outcome: 'enqueued' },
      { providerMessageId: 'wamid.2', outcome: 'duplicate' },
    ]);
  });
});

describe('WebhookIngestService delivery status callbacks', () => {
  const statusUpdate = (
    overrides: Partial<NormalizedStatusUpdate> = {},
  ): NormalizedStatusUpdate => ({
    channel: 'whatsapp',
    channelAccountId: 'pn-1',
    providerMessageId: 'wamid.out',
    status: 'delivered',
    error: null,
    occurredAt: new Date('2026-08-18T10:00:00Z'),
    ...overrides,
  });

  it('applies a status callback to the stored outbound message', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);
    mocks.applyDeliveryStatus.mockResolvedValue(true);
    const adapter = makeAdapter([], true, [statusUpdate()]);

    const results = await service.ingest(adapter, '{}', {});

    expect(mocks.applyDeliveryStatus).toHaveBeenCalledWith(
      'tenant-a',
      'wamid.out',
      'delivered',
      null,
    );
    expect(results).toEqual([
      { providerMessageId: 'wamid.out', outcome: 'delivery_status_applied' },
    ]);
  });

  it('reports an unmatched callback as an outcome, not an error — Meta reports on messages older than our retention window', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);
    mocks.applyDeliveryStatus.mockResolvedValue(false);
    const adapter = makeAdapter([], true, [statusUpdate()]);

    const results = await service.ingest(adapter, '{}', {});

    expect(results).toEqual([
      { providerMessageId: 'wamid.out', outcome: 'delivery_status_unmatched' },
    ]);
  });

  it('does not rate-limit or dedup status callbacks — the same id legitimately reports sent, then delivered, then read', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);
    mocks.applyDeliveryStatus.mockResolvedValue(true);
    const adapter = makeAdapter([], true, [
      statusUpdate({ status: 'sent' }),
      statusUpdate({ status: 'delivered' }),
      statusUpdate({ status: 'read' }),
    ]);

    const results = await service.ingest(adapter, '{}', {});

    expect(results).toHaveLength(3);
    expect(mocks.allow).not.toHaveBeenCalled();
    expect(mocks.checkAndRecord).not.toHaveBeenCalled();
  });

  it('ignores a delivery callback for a closed workspace', async () => {
    const mocks = makeMocks({ isClosed: jest.fn().mockResolvedValue(true) });
    const service = makeService(mocks);
    const adapter = makeAdapter([], true, [statusUpdate()]);

    const results = await service.ingest(adapter, '{}', {});

    expect(results).toEqual([
      { providerMessageId: 'wamid.out', outcome: 'workspace_closed' },
    ]);
    expect(mocks.applyDeliveryStatus).not.toHaveBeenCalled();
  });

  it('carries the vendor failure detail through to the message row', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);
    mocks.applyDeliveryStatus.mockResolvedValue(true);
    const adapter = makeAdapter([], true, [
      statusUpdate({ status: 'failed', error: '131047: outside 24h window' }),
    ]);

    await service.ingest(adapter, '{}', {});

    expect(mocks.applyDeliveryStatus).toHaveBeenCalledWith(
      'tenant-a',
      'wamid.out',
      'failed',
      '131047: outside 24h window',
    );
  });
});

describe('WebhookIngestService.ingest() — consent', () => {
  // Honoured before the agent is queued, not after. A STOP acted on only once
  // the reply pipeline gets round to it is a STOP the customer watched us
  // ignore.
  it('records an opt-out and never queues the agent for it', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);
    const adapter = makeAdapter([makeMessage({ text: 'STOP' })]);

    const results = await service.ingest(adapter, '{}', {});

    expect(results).toEqual([
      { providerMessageId: 'wamid.1', outcome: 'opted_out' },
    ]);
    expect(mocks.recordOptOut).toHaveBeenCalledWith(
      'tenant-a',
      '15551234567',
      'customer_keyword',
      'whatsapp',
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('records an opt-in on START', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);
    const adapter = makeAdapter([makeMessage({ text: 'start' })]);

    const results = await service.ingest(adapter, '{}', {});

    expect(results).toEqual([
      { providerMessageId: 'wamid.1', outcome: 'opted_in' },
    ]);
    expect(mocks.recordOptIn).toHaveBeenCalledWith(
      'tenant-a',
      '15551234567',
      'whatsapp',
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  // Confirming an opt-out with a message is itself a message to someone who
  // just asked for none, and WhatsApp sends its own confirmation.
  it('sends no auto-reply either way', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);

    await service.ingest(adapterFor('STOP'), '{}', {});
    await service.ingest(adapterFor('START'), '{}', {});

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.createTicket).not.toHaveBeenCalled();

    function adapterFor(text: string) {
      return makeAdapter([makeMessage({ text })]);
    }
  });

  // They re-opened the service window themselves, so a human must see it —
  // but an opt-out is not consent to be auto-replied to.
  it('escalates to a human when an opted-out customer messages again, without running the agent', async () => {
    const mocks = makeMocks({
      isOptedOut: jest.fn().mockResolvedValue(true),
    });
    const service = makeService(mocks);
    const adapter = makeAdapter([
      makeMessage({ text: 'actually I need help' }),
    ]);

    const results = await service.ingest(adapter, '{}', {});

    expect(results).toEqual([
      { providerMessageId: 'wamid.1', outcome: 'escalated_opted_out' },
    ]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    const [args] = mocks.createTicket.mock.calls[0] as [
      { escalationReason: string },
    ];
    expect(args.escalationReason).toBe('OPTED_OUT_CUSTOMER');
  });

  it('leaves an ordinary message from a consenting customer untouched', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);
    const adapter = makeAdapter([makeMessage({ text: 'where is my order' })]);

    const results = await service.ingest(adapter, '{}', {});

    expect(results).toEqual([
      { providerMessageId: 'wamid.1', outcome: 'enqueued' },
    ]);
    expect(mocks.recordOptOut).not.toHaveBeenCalled();
  });
});

// F17: T3's amended escalation matrix. Only media we genuinely cannot read
// still hard-escalates at intake; a whitelisted image or voice note is recorded
// and handed to the media-download worker, which enqueues the agent turn once
// the bytes exist.
describe('WebhookIngestService.ingest() — F17 media understanding', () => {
  function mediaMessage(
    overrides: Partial<NormalizedInboundMessage> = {},
  ): NormalizedInboundMessage {
    return makeMessage({
      type: 'image',
      text: undefined,
      media: {
        mediaId: 'media-1',
        mimeType: 'image/jpeg',
        filename: null,
        caption: 'how much is this?',
      },
      ...overrides,
    });
  }

  it('accepts a photo for understanding instead of escalating it', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);

    const results = await service.ingest(
      makeAdapter([mediaMessage()]),
      '{}',
      {},
    );

    expect(results).toEqual([
      {
        providerMessageId: 'wamid.1',
        outcome: 'media_queued_for_understanding',
      },
    ]);
    expect(mocks.createTicket).not.toHaveBeenCalled();
    // Not enqueued HERE: the bytes do not exist yet.
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.recordMedia).toHaveBeenCalledWith(
      'tenant-a',
      'conv-1',
      expect.anything(),
      'image',
    );
  });

  it('accepts a voice note for understanding', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);
    const message = mediaMessage({
      type: 'voice',
      media: {
        mediaId: 'media-2',
        mimeType: 'audio/ogg; codecs=opus',
        filename: null,
        caption: null,
      },
    });

    const results = await service.ingest(makeAdapter([message]), '{}', {});

    expect(results[0].outcome).toBe('media_queued_for_understanding');
    expect(mocks.recordMedia).toHaveBeenCalledWith(
      'tenant-a',
      'conv-1',
      expect.anything(),
      'voice',
    );
  });

  it('still hard-escalates a document — the matrix moved only for images and voice', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);
    const message = mediaMessage({
      type: 'document',
      media: {
        mediaId: 'media-3',
        mimeType: 'application/pdf',
        filename: 'invoice.pdf',
        caption: null,
      },
    });

    const results = await service.ingest(makeAdapter([message]), '{}', {});

    expect(results[0].outcome).toBe('escalated_unsupported_media');
    expect(mocks.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ escalationReason: 'UNSUPPORTED_MEDIA' }),
    );
  });

  it('escalates rather than dropping when the download could not be queued', async () => {
    const mocks = makeMocks({
      recordMedia: jest
        .fn()
        .mockResolvedValue({ messageId: 'message-1', queued: false }),
    });
    const service = makeService(mocks);

    const results = await service.ingest(
      makeAdapter([mediaMessage()]),
      '{}',
      {},
    );

    expect(results[0].outcome).toBe('escalated_unsupported_media');
    expect(mocks.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ escalationReason: 'UNSUPPORTED_MEDIA' }),
    );
  });

  it('never auto-answers an opted-out customer, whatever they sent', async () => {
    const mocks = makeMocks({ isOptedOut: jest.fn().mockResolvedValue(true) });
    const service = makeService(mocks);

    const results = await service.ingest(
      makeAdapter([mediaMessage()]),
      '{}',
      {},
    );

    expect(results[0].outcome).toBe('escalated_opted_out');
    expect(mocks.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ escalationReason: 'OPTED_OUT_CUSTOMER' }),
    );
    // The attachment is still recorded for the human, just not for the agent.
    expect(mocks.recordMedia).toHaveBeenCalledWith(
      'tenant-a',
      'conv-1',
      expect.anything(),
      null,
    );
  });
});

// Gulf T3 (D13): WhatsApp Business app coexistence echoes.
describe('WebhookIngestService.ingest() — business app echoes (D13)', () => {
  function echo(
    overrides: Partial<NormalizedOutboundEcho> = {},
  ): NormalizedOutboundEcho {
    return {
      channel: 'whatsapp',
      channelAccountId: 'pn-1',
      providerMessageId: 'wamid.echo1',
      to: '15551234567',
      type: 'text',
      text: 'Sent from my phone',
      sentAt: new Date('2026-09-19T10:00:00Z'),
      ...overrides,
    };
  }

  it('stores the echo as human-sent in the customer conversation and never enqueues the agent', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);

    const results = await service.ingest(
      makeAdapter([], true, [], [echo()]),
      '{}',
      {},
    );

    expect(results).toEqual([
      {
        providerMessageId: 'wamid.echo1',
        outcome: 'business_app_echo_recorded',
      },
    ]);
    expect(mocks.getOrCreateConversation).toHaveBeenCalledWith(
      'tenant-a',
      '15551234567',
      'pn-1',
      'whatsapp',
    );
    expect(mocks.recordBusinessAppEcho).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      conversationId: 'conv-1',
      providerMessageId: 'wamid.echo1',
      content: 'Sent from my phone',
      sentAt: new Date('2026-09-19T10:00:00Z'),
    });
    // The agent must not talk over the human: same handover a console
    // reply takes, with no console user behind it.
    expect(mocks.startHandover).toHaveBeenCalledWith(
      'tenant-a',
      'conv-1',
      null,
      new Date('2026-09-19T10:00:00Z'),
    );
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.createTicket).not.toHaveBeenCalled();
    expect(mocks.allow).not.toHaveBeenCalled();
  });

  it('dedups a redelivered echo', async () => {
    const mocks = makeMocks({
      checkAndRecord: jest.fn().mockResolvedValue({ isDuplicate: true }),
    });
    const service = makeService(mocks);

    const results = await service.ingest(
      makeAdapter([], true, [], [echo()]),
      '{}',
      {},
    );

    expect(results[0].outcome).toBe('duplicate');
    expect(mocks.recordBusinessAppEcho).not.toHaveBeenCalled();
    expect(mocks.startHandover).not.toHaveBeenCalled();
  });

  it('records nothing for a closed workspace', async () => {
    const mocks = makeMocks({ isClosed: jest.fn().mockResolvedValue(true) });
    const service = makeService(mocks);

    const results = await service.ingest(
      makeAdapter([], true, [], [echo()]),
      '{}',
      {},
    );

    expect(results[0].outcome).toBe('workspace_closed');
    expect(mocks.recordBusinessAppEcho).not.toHaveBeenCalled();
  });

  it('describes a media echo by its caption, else a plain marker', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);

    await service.ingest(
      makeAdapter(
        [],
        true,
        [],
        [
          echo({
            providerMessageId: 'wamid.e2',
            type: 'image',
            text: undefined,
            media: {
              mediaId: 'm1',
              mimeType: 'image/jpeg',
              filename: null,
              caption: 'Here is the invoice',
            },
          }),
          echo({
            providerMessageId: 'wamid.e3',
            type: 'voice',
            text: undefined,
          }),
        ],
      ),
      '{}',
      {},
    );

    expect(mocks.recordBusinessAppEcho).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ content: 'Here is the invoice' }),
    );
    expect(mocks.recordBusinessAppEcho).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        content: '[voice sent from the WhatsApp Business app]',
      }),
    );
  });

  it('handles an echo and a customer message in the same delivery independently', async () => {
    const mocks = makeMocks();
    const service = makeService(mocks);

    const results = await service.ingest(
      makeAdapter([makeMessage()], true, [], [echo()]),
      '{}',
      {},
    );

    expect(results.map((r) => r.outcome)).toEqual([
      'business_app_echo_recorded',
      'enqueued',
    ]);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ providerMessageId: 'wamid.1' }),
    );
  });
});
