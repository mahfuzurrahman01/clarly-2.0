import type { Queue } from 'bullmq';
import type { AppLoggerService } from '../core';
import type { ConversationService } from '../conversation/conversation.service';
import type { NormalizedInboundMessage } from '../channel/ports/channel-adapter.port';
import { MediaIntakeService } from './media-intake.service';
import type { MediaDownloadJobData } from './media-download.queue';

const TENANT = 'tenant-a';
const CONVERSATION = 'conv-1';

function message(
  overrides: Partial<NormalizedInboundMessage> = {},
): NormalizedInboundMessage {
  return {
    channel: 'whatsapp' as const,
    channelAccountId: 'pn-1',
    providerMessageId: 'wamid.IMG',
    from: '+8801711000001',
    type: 'image',
    media: {
      mediaId: 'media-123',
      mimeType: 'image/jpeg',
      filename: null,
      caption: null,
    },
    receivedAt: new Date('2026-08-20T10:00:00Z'),
    ...overrides,
  };
}

function makeService() {
  const recordInboundMediaMessage = jest.fn<
    Promise<string>,
    [{ content: string; mediaId: string }]
  >(() => Promise.resolve('message-1'));
  const add = jest.fn().mockResolvedValue({ id: 'job-1' });
  const error = jest.fn();

  return {
    service: new MediaIntakeService(
      { recordInboundMediaMessage } as unknown as ConversationService,
      { add } as unknown as Queue<MediaDownloadJobData>,
      { error } as unknown as AppLoggerService,
    ),
    recordInboundMediaMessage,
    add,
    error,
  };
}

describe('MediaIntakeService.record()', () => {
  it('records the message and queues its bytes', async () => {
    const { service, recordInboundMediaMessage, add } = makeService();

    const recorded = await service.record(TENANT, CONVERSATION, message());

    // F17: the caller needs to know the download was actually queued, not just
    // which row was written — an attachment the agent is meant to answer has no
    // escalation ticket behind it.
    expect(recorded).toEqual({ messageId: 'message-1', queued: true });
    expect(recordInboundMediaMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        conversationId: CONVERSATION,
        providerMessageId: 'wamid.IMG',
        mediaId: 'media-123',
        mimeType: 'image/jpeg',
      }),
    );
    // Gulf T6: the job names its channel and carries the handle as a typed
    // source, so the worker looks the adapter up instead of assuming WhatsApp.
    expect(add).toHaveBeenCalledWith('media-download', {
      tenantId: TENANT,
      messageId: 'message-1',
      channel: 'whatsapp',
      channelAccountId: 'pn-1',
      source: { mediaId: 'media-123' },
      filename: null,
    });
  });

  it.each(['messenger', 'instagram'] as const)(
    'queues a %s attachment by its CDN url (Gulf T6, D9)',
    async (channel) => {
      const { service, recordInboundMediaMessage, add } = makeService();
      const url = 'https://scontent.xx.fbcdn.net/v/photo.jpg?oh=sig';

      const recorded = await service.record(
        TENANT,
        CONVERSATION,
        message({
          channel,
          channelAccountId: 'page-1',
          providerMessageId: 'mid.IMG',
          from: 'PSID-1',
          media: {
            mediaUrl: url,
            mimeType: null,
            filename: null,
            caption: null,
          },
        }),
        'image',
      );

      expect(recorded).toEqual({ messageId: 'message-1', queued: true });
      expect(recordInboundMediaMessage).toHaveBeenCalledWith(
        expect.objectContaining({ mediaId: url, mimeType: null }),
      );
      expect(add).toHaveBeenCalledWith('media-download', {
        tenantId: TENANT,
        messageId: 'message-1',
        channel,
        channelAccountId: 'page-1',
        source: { mediaUrl: url },
        filename: null,
        understanding: {
          kind: 'image',
          mimeType: '',
          providerMessageId: 'mid.IMG',
          from: 'PSID-1',
          caption: '',
        },
      });
    },
  );

  // The transcript previously said nothing at all for a non-text message.
  it('writes a readable placeholder when the customer sent no caption', async () => {
    const { service, recordInboundMediaMessage } = makeService();

    await service.record(TENANT, CONVERSATION, message());

    expect(recordInboundMediaMessage.mock.calls[0][0].content).toBe(
      '[the customer sent an image]',
    );
  });

  it("keeps the caption when there is one — it is the customer's own words", async () => {
    const { service, recordInboundMediaMessage } = makeService();

    await service.record(
      TENANT,
      CONVERSATION,
      message({
        media: {
          mediaId: 'media-123',
          mimeType: 'image/jpeg',
          filename: null,
          caption: 'this arrived broken',
        },
      }),
    );

    expect(recordInboundMediaMessage.mock.calls[0][0].content).toBe(
      'this arrived broken',
    );
  });

  it('uses a placeholder for a caption that is only whitespace', async () => {
    const { service, recordInboundMediaMessage } = makeService();

    await service.record(
      TENANT,
      CONVERSATION,
      message({
        media: {
          mediaId: 'media-123',
          mimeType: 'image/jpeg',
          filename: null,
          caption: '   ',
        },
      }),
    );

    expect(recordInboundMediaMessage.mock.calls[0][0].content).toBe(
      '[the customer sent an image]',
    );
  });

  it('names the type in the placeholder so the transcript says what arrived', async () => {
    const { service, recordInboundMediaMessage } = makeService();

    await service.record(TENANT, CONVERSATION, message({ type: 'voice' }));

    expect(recordInboundMediaMessage.mock.calls[0][0].content).toBe(
      '[the customer sent a voice message]',
    );
  });

  it('does nothing for a non-text message that carried no media at all', async () => {
    const { service, recordInboundMediaMessage, add } = makeService();

    const messageId = await service.record(
      TENANT,
      CONVERSATION,
      message({ type: 'unsupported', media: undefined }),
    );

    // A location or a reaction still escalates; there is just nothing to fetch.
    expect(messageId).toBeNull();
    expect(recordInboundMediaMessage).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  // The escalation is the thing that must not be lost.
  it('still records the message when the queue is down', async () => {
    const { service, recordInboundMediaMessage, add, error } = makeService();
    add.mockRejectedValue(new Error('redis is down'));

    const recorded = await service.record(TENANT, CONVERSATION, message());

    expect(recorded).toEqual({ messageId: 'message-1', queued: false });
    expect(recordInboundMediaMessage).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });
});
