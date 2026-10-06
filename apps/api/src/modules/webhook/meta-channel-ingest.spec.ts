// Feature 16 exit criteria, exercised against the REAL WebhookIngestService
// rather than a Meta-specific copy of it.
//
// That is the whole claim under test: there is no Meta-specific ingest path.
// The same service, with the same dedup (T6), the same rate limiter (T17),
// the same consent handling and the same T11 enqueue, is handed a
// `ChannelAdapter` tagged 'messenger' or 'instagram' instead of 'whatsapp'
// and behaves identically. If someone later adds an `if (channel === ...)`
// to that service, these tests keep passing but the WhatsApp ones start
// diverging from them — which is exactly the signal you want.
//
// What is NOT proven here (and cannot be until Meta Tech Provider approval):
// that Meta's live webhook payloads match the fixtures the parser tests use,
// and that a real page token sends. Everything between those two points is
// real code running.
import type { CampaignDeliveryTracker } from '../campaign/campaign-delivery.tracker';
import type { CommentThreadService } from '../comments/comment-thread.service';
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
import type {
  ChannelAdapter,
  NormalizedInboundMessage,
} from '../channel/ports/channel-adapter.port';
import type { ChannelKind } from '../channel/ports/channel-kind';
import { WebhookIngestService } from './webhook-ingest.service';

const TENANT = 'tenant-a';

function makeMessage(
  channel: ChannelKind,
  overrides: Partial<NormalizedInboundMessage> = {},
): NormalizedInboundMessage {
  return {
    channel,
    channelAccountId: channel === 'instagram' ? 'ig-1' : 'page-1',
    providerMessageId: 'mid.abc123',
    from: 'PSID-9001',
    type: 'text',
    text: 'do you ship to Chittagong?',
    receivedAt: new Date('2026-09-06T12:00:00Z'),
    ...overrides,
  };
}

function makeAdapter(
  channel: ChannelKind,
  messages: NormalizedInboundMessage[],
): ChannelAdapter {
  return {
    channel,
    verifyWebhookSignature: jest.fn().mockReturnValue(true),
    parseInboundWebhook: jest.fn().mockReturnValue(messages),
    parseStatusUpdates: jest.fn().mockReturnValue([]),
    parseOutboundEchoes: jest.fn().mockReturnValue([]),
    sendText: jest.fn(),
    downloadMedia: jest.fn(),
    verifySubscription: jest.fn().mockReturnValue(null),
  };
}

function makeHarness() {
  // A REAL dedup implementation over an in-memory set, keyed exactly the way
  // `webhook_message_dedup`'s unique(tenant_id, bsp_message_id) constraint is.
  // Faking it as "always new" would make the replay test prove nothing.
  const seen = new Set<string>();
  const checkAndRecord = jest.fn((tenantId: string, messageId: string) => {
    const key = `${tenantId}:${messageId}`;
    const isDuplicate = seen.has(key);
    seen.add(key);
    return Promise.resolve({ isDuplicate });
  });

  const resolveTenantId = jest.fn().mockResolvedValue(TENANT);
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const createTicket = jest.fn().mockResolvedValue({ id: 'ticket-1' });
  const getOrCreateByPhone = jest.fn().mockResolvedValue({ id: 'customer-1' });
  const getOrCreateConversation = jest.fn().mockResolvedValue({ id: 'conv-1' });
  const isOptedOut = jest.fn().mockResolvedValue(false);
  const recordOptOut = jest.fn().mockResolvedValue({});
  const recordOptIn = jest.fn().mockResolvedValue({});
  const recordMedia = jest
    .fn()
    .mockResolvedValue({ messageId: 'message-1', queued: true });

  const service = new WebhookIngestService(
    { resolveTenantId } as unknown as ChannelTenantResolver,
    {
      isClosed: jest.fn().mockResolvedValue(false),
    } as unknown as TenantStatusService,
    {
      allow: jest.fn().mockResolvedValue(true),
    } as unknown as WebhookRateLimiterService,
    { checkAndRecord } as unknown as WebhookDedupService,
    { enqueue } as unknown as RespondPathProducerService,
    { createTicket } as unknown as TicketEscalationService,
    { getOrCreateByPhone } as unknown as CustomerService,
    {
      isOptedOut,
      recordOptOut,
      recordOptIn,
    } as unknown as CustomerConsentService,
    {
      getOrCreateConversation,
      applyDeliveryStatus: jest.fn().mockResolvedValue(true),
    } as unknown as ConversationService,
    { record: recordMedia } as unknown as MediaIntakeService,
    {
      adoptOnCustomerMessage: jest.fn().mockResolvedValue(null),
    } as unknown as CommentThreadService,
    // F19 (D5): a social-channel message is almost never a campaign reply,
    // so the honest default here is "nothing to attribute".
    {
      apply: jest.fn().mockResolvedValue(false),
      attributeReplyFromPhone: jest.fn().mockResolvedValue(false),
    } as unknown as CampaignDeliveryTracker,
  );

  return {
    service,
    resolveTenantId,
    enqueue,
    createTicket,
    getOrCreateByPhone,
    getOrCreateConversation,
    isOptedOut,
    recordOptOut,
    checkAndRecord,
  };
}

describe.each(['messenger', 'instagram'] as const)(
  'WebhookIngestService on %s (Feature 16)',
  (channel) => {
    it('resolves the tenant from the page/IG account id BEFORE any tenant-scoped work (T6)', async () => {
      const harness = makeHarness();
      const message = makeMessage(channel);

      await harness.service.ingest(makeAdapter(channel, [message]), '{}', {});

      expect(harness.resolveTenantId).toHaveBeenCalledWith(
        channel,
        message.channelAccountId,
      );
    });

    it('enqueues one respond-path turn carrying the channel, so the reply goes back out the same one', async () => {
      const harness = makeHarness();
      const message = makeMessage(channel);

      const results = await harness.service.ingest(
        makeAdapter(channel, [message]),
        '{}',
        {},
      );

      expect(results).toEqual([
        { providerMessageId: 'mid.abc123', outcome: 'enqueued' },
      ]);
      expect(harness.enqueue).toHaveBeenCalledWith({
        tenantId: TENANT,
        channel,
        channelAccountId: message.channelAccountId,
        providerMessageId: 'mid.abc123',
        from: 'PSID-9001',
        text: 'do you ship to Chittagong?',
      });
    });

    it('a REPLAYED webhook produces exactly one reply, never two (T6, unchanged for a new channel)', async () => {
      // Feature 16's own exit criterion. Meta redelivers a webhook verbatim
      // on any non-200, exactly as WhatsApp's BSP does, so this is the
      // failure mode most likely to reach a customer as a double reply.
      const harness = makeHarness();
      const message = makeMessage(channel);
      const adapter = makeAdapter(channel, [message]);

      const first = await harness.service.ingest(adapter, '{}', {});
      const replay = await harness.service.ingest(adapter, '{}', {});
      const thirdTime = await harness.service.ingest(adapter, '{}', {});

      expect(first).toEqual([
        { providerMessageId: 'mid.abc123', outcome: 'enqueued' },
      ]);
      expect(replay).toEqual([
        { providerMessageId: 'mid.abc123', outcome: 'duplicate' },
      ]);
      expect(thirdTime).toEqual([
        { providerMessageId: 'mid.abc123', outcome: 'duplicate' },
      ]);
      // The assertion that actually matters: one turn was queued, so one
      // reply is sent.
      expect(harness.enqueue).toHaveBeenCalledTimes(1);
    });

    it('scopes the customer and conversation to the channel, so a PSID never merges into a WhatsApp profile', async () => {
      const harness = makeHarness();
      // A PSID that is also a plausible phone number. Without `channel` in
      // the identity key this would collide with a real WhatsApp customer.
      const message = makeMessage(channel, { from: '15551234567' });

      await harness.service.ingest(
        makeAdapter(channel, [
          message,
          {
            ...message,
            type: 'image',
            text: undefined,
            providerMessageId: 'mid.img',
            media: {
              mediaUrl: 'https://cdn/x',
              mimeType: null,
              filename: null,
              caption: null,
            },
          },
        ]),
        '{}',
        {},
      );

      expect(harness.getOrCreateByPhone).toHaveBeenCalledWith(
        TENANT,
        '15551234567',
        channel,
      );
      expect(harness.getOrCreateConversation).toHaveBeenCalledWith(
        TENANT,
        '15551234567',
        message.channelAccountId,
        channel,
      );
    });

    it('honours a STOP keyword on this channel, scoped to this channel', async () => {
      const harness = makeHarness();

      const results = await harness.service.ingest(
        makeAdapter(channel, [makeMessage(channel, { text: 'STOP' })]),
        '{}',
        {},
      );

      expect(results).toEqual([
        { providerMessageId: 'mid.abc123', outcome: 'opted_out' },
      ]);
      expect(harness.recordOptOut).toHaveBeenCalledWith(
        TENANT,
        'PSID-9001',
        'customer_keyword',
        channel,
      );
      expect(harness.enqueue).not.toHaveBeenCalled();
    });

    it('queues a photo for understanding instead of escalating it (Gulf T6: F17 on every channel)', async () => {
      // Messenger/Instagram declare no mime type; the modality comes from the
      // attachment type, and the fetched bytes are checked before any model
      // sees them.
      const harness = makeHarness();

      const results = await harness.service.ingest(
        makeAdapter(channel, [
          makeMessage(channel, {
            type: 'image',
            text: undefined,
            media: {
              mediaUrl: 'https://scontent.xx.fbcdn.net/x.jpg',
              mimeType: null,
              filename: null,
              caption: null,
            },
          }),
        ]),
        '{}',
        {},
      );

      expect(results).toEqual([
        {
          providerMessageId: 'mid.abc123',
          outcome: 'media_queued_for_understanding',
        },
      ]);
      expect(harness.createTicket).not.toHaveBeenCalled();
    });

    it('still escalates a document attachment to a human', async () => {
      const harness = makeHarness();

      const results = await harness.service.ingest(
        makeAdapter(channel, [
          makeMessage(channel, {
            type: 'document',
            text: undefined,
            media: {
              mediaUrl: 'https://scontent.xx.fbcdn.net/x.pdf',
              mimeType: null,
              filename: null,
              caption: null,
            },
          }),
        ]),
        '{}',
        {},
      );

      expect(results).toEqual([
        {
          providerMessageId: 'mid.abc123',
          outcome: 'escalated_unsupported_media',
        },
      ]);
      expect(harness.createTicket).toHaveBeenCalledWith(
        expect.objectContaining({ escalationReason: 'UNSUPPORTED_MEDIA' }),
      );
    });
  },
);

describe('cross-channel independence (Feature 16)', () => {
  it('does not dedup a Messenger message against an identical WhatsApp one from another account', async () => {
    // Provider message ids are namespaced per product in practice, but the
    // guarantee we want does not depend on that: dedup is keyed on
    // (tenant, provider message id), and two DIFFERENT ids must both pass.
    const harness = makeHarness();

    await harness.service.ingest(
      makeAdapter('whatsapp', [
        makeMessage('whatsapp', {
          channelAccountId: 'pn-1',
          providerMessageId: 'wamid.1',
          from: '15551234567',
        }),
      ]),
      '{}',
      {},
    );
    await harness.service.ingest(
      makeAdapter('messenger', [
        makeMessage('messenger', { providerMessageId: 'mid.1' }),
      ]),
      '{}',
      {},
    );

    expect(harness.enqueue).toHaveBeenCalledTimes(2);
    const enqueued = harness.enqueue.mock.calls.map(
      ([job]) => (job as { channel: ChannelKind }).channel,
    );
    expect(enqueued).toEqual(['whatsapp', 'messenger']);
  });
});
