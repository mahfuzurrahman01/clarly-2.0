import type { Job } from 'bullmq';
import type { AppConfigService, AppLoggerService } from '../core';
import type { ConversationService } from '../conversation/conversation.service';
import type { ObjectStorage } from '../storage/ports/object-storage.port';
import type { RespondPathProducerService } from './respond-path-producer.service';
import type { CustomerService } from '../customer/customer.service';
import type { TicketEscalationService } from '../ticket/ticket-escalation.service';
import type { ChannelRegistry } from '../channel/channel-registry.service';
import {
  MediaRejectedError,
  MediaTooLargeError,
} from '../channel/ports/media-download.errors';
import { MediaDownloadProcessor } from './media-download.processor';
import type {
  LegacyMediaDownloadJobData,
  MediaDownloadJobData,
} from './media-download.queue';

const JOB_DATA: MediaDownloadJobData = {
  tenantId: 'tenant-a',
  messageId: 'message-1',
  channel: 'whatsapp',
  channelAccountId: 'pn-1',
  source: { mediaId: 'media-123' },
  filename: 'invoice.pdf',
};

function makeJob(overrides: Partial<Job<MediaDownloadJobData>> = {}) {
  return {
    id: 'job-1',
    data: JOB_DATA,
    opts: { attempts: 3 },
    attemptsMade: 1,
    ...overrides,
  } as Job<MediaDownloadJobData>;
}

function makeProcessor(maxBytes = 25 * 1024 * 1024) {
  const downloadMedia = jest.fn().mockResolvedValue({
    content: Buffer.from('the bytes'),
    mimeType: 'application/pdf',
  });
  const upload = jest
    .fn()
    .mockResolvedValue({ storageKey: 'tenant-a/abc', sizeBytes: 9 });
  const markMediaStored = jest.fn<
    Promise<void>,
    [string, string, { mimeType: string | null }]
  >(() => Promise.resolve());
  const markMediaFailed = jest.fn().mockResolvedValue(undefined);
  const enqueueRespondPath = jest.fn().mockResolvedValue(undefined);
  const getOrCreateByPhone = jest.fn().mockResolvedValue({ id: 'customer-1' });
  const getOrCreateConversation = jest
    .fn()
    .mockResolvedValue({ id: 'conversation-1' });
  const createTicket = jest.fn().mockResolvedValue({ id: 't1' });
  const adapterFor = jest.fn(() => ({ downloadMedia }));

  return {
    processor: new MediaDownloadProcessor(
      { for: adapterFor } as unknown as ChannelRegistry,
      { upload } as unknown as ObjectStorage,
      {
        markMediaStored,
        markMediaFailed,
        getOrCreateConversation,
      } as unknown as ConversationService,
      { inboundMediaMaxBytes: maxBytes } as unknown as AppConfigService,
      {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      } as unknown as AppLoggerService,
      // F17 dependencies. Stubbed rather than exercised here: this suite
      // covers the fetch/store half, which is all it covered before F17 —
      // the understanding hand-off has its own coverage.
      { enqueue: enqueueRespondPath } as unknown as RespondPathProducerService,
      { getOrCreateByPhone } as unknown as CustomerService,
      { createTicket } as unknown as TicketEscalationService,
    ),
    enqueueRespondPath,
    enqueue: enqueueRespondPath,
    createTicket,
    downloadMedia,
    adapterFor,
    getOrCreateByPhone,
    getOrCreateConversation,
    upload,
    markMediaStored,
    markMediaFailed,
  };
}

describe('MediaDownloadProcessor', () => {
  it('fetches the bytes, stores them, and completes the message', async () => {
    const { processor, downloadMedia, adapterFor, upload, markMediaStored } =
      makeProcessor();

    await processor.process(makeJob());

    // Gulf T6, critical regression #3: WhatsApp media still downloads, now
    // through the channel's adapter.
    expect(adapterFor).toHaveBeenCalledWith('whatsapp');
    expect(downloadMedia).toHaveBeenCalledWith('pn-1', {
      mediaId: 'media-123',
    });
    expect(upload).toHaveBeenCalledWith(
      'tenant-a',
      'invoice.pdf',
      expect.any(Buffer),
    );
    expect(markMediaStored).toHaveBeenCalledWith('tenant-a', 'message-1', {
      storageKey: 'tenant-a/abc',
      sizeBytes: 9,
      mimeType: 'application/pdf',
    });
  });

  it("prefers the fetch's content type over the webhook's", async () => {
    const { processor, markMediaStored } = makeProcessor();

    await processor.process(makeJob());

    // The fetch is the response that actually carried the bytes.
    expect(markMediaStored.mock.calls[0][2].mimeType).toBe('application/pdf');
  });

  // Refusal, not a throw: a retry would fetch the same oversized bytes again.
  it('refuses an attachment over the limit without retrying', async () => {
    const { processor, upload, markMediaFailed, markMediaStored } =
      makeProcessor(4);

    await processor.process(makeJob());

    expect(upload).not.toHaveBeenCalled();
    expect(markMediaStored).not.toHaveBeenCalled();
    expect(markMediaFailed).toHaveBeenCalledWith(
      'tenant-a',
      'message-1',
      'too_large',
      expect.stringContaining('over the 4-byte limit'),
    );
  });

  it('propagates a BSP failure so BullMQ retries it', async () => {
    const { processor, downloadMedia } = makeProcessor();
    downloadMedia.mockRejectedValue(new Error('HTTP 401'));

    await expect(processor.process(makeJob())).rejects.toThrow('HTTP 401');
  });

  describe('onFailed()', () => {
    it('leaves the row pending while attempts remain', async () => {
      const { processor, markMediaFailed } = makeProcessor();

      await processor.onFailed(
        makeJob({ attemptsMade: 1 }),
        new Error('timeout'),
      );

      expect(markMediaFailed).not.toHaveBeenCalled();
    });

    // A permanent spinner is worse than "could not be retrieved": only one of
    // them tells the person to ask the customer to resend.
    it('marks the row failed once attempts are exhausted', async () => {
      const { processor, markMediaFailed } = makeProcessor();

      await processor.onFailed(
        makeJob({ attemptsMade: 3 }),
        new Error('media id expired'),
      );

      expect(markMediaFailed).toHaveBeenCalledWith(
        'tenant-a',
        'message-1',
        'failed',
        'media id expired',
      );
    });

    it('does not take the worker down when recording the failure also fails', async () => {
      const { processor, markMediaFailed } = makeProcessor();
      markMediaFailed.mockRejectedValue(new Error('db is down'));

      await expect(
        processor.onFailed(makeJob({ attemptsMade: 3 }), new Error('gone')),
      ).resolves.toBeUndefined();
    });

    it('ignores a failure event with no job', async () => {
      const { processor, markMediaFailed } = makeProcessor();

      await processor.onFailed(undefined, new Error('gone'));

      expect(markMediaFailed).not.toHaveBeenCalled();
    });
  });
});

// F17: an image or voice note the agent is expected to ANSWER carries an
// `understanding` block and, deliberately, no escalation ticket. Everything
// below is about that difference — the turn continues, or a human gets it,
// never neither.
describe('MediaDownloadProcessor — F17 understanding continuation', () => {
  const UNDERSTANDABLE: MediaDownloadJobData = {
    tenantId: 'tenant-a',
    messageId: 'message-9',
    channel: 'whatsapp',
    channelAccountId: 'pn-1',
    source: { mediaId: 'media-999' },
    filename: 'photo.jpg',
    understanding: {
      kind: 'image',
      mimeType: 'image/jpeg',
      providerMessageId: 'wamid.IMG',
      from: '+8801700000000',
      caption: 'how much is this?',
    },
  };

  function understandableJob(
    overrides: Partial<Job<MediaDownloadJobData>> = {},
  ) {
    return {
      id: 'job-9',
      data: UNDERSTANDABLE,
      opts: { attempts: 3 },
      attemptsMade: 1,
      ...overrides,
    } as Job<MediaDownloadJobData>;
  }

  it('enqueues the agent turn once the bytes are stored, with the storage-observed mime type', async () => {
    const { processor, enqueue, downloadMedia, createTicket } = makeProcessor();
    downloadMedia.mockResolvedValue({
      content: Buffer.from('image bytes'),
      mimeType: 'image/jpeg',
    });

    await processor.process(understandableJob());

    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        from: '+8801700000000',
        text: 'how much is this?',
        media: {
          messageId: 'message-9',
          kind: 'image',
          mimeType: 'image/jpeg',
          storageKey: 'tenant-a/abc',
        },
      }),
    );
    // No ticket: this is a normal turn now, not a handoff.
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('escalates instead of dropping when the attachment is too large to keep', async () => {
    const { processor, enqueue, createTicket } = makeProcessor(4);

    await processor.process(understandableJob());

    expect(enqueue).not.toHaveBeenCalled();
    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ escalationReason: 'UNSUPPORTED_MEDIA' }),
    );
  });

  it('escalates when the turn cannot be queued, rather than failing the job into a re-download', async () => {
    const { processor, enqueue, createTicket } = makeProcessor();
    enqueue.mockRejectedValue(new Error('redis is down'));

    await expect(
      processor.process(understandableJob()),
    ).resolves.toBeUndefined();

    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ escalationReason: 'UNSUPPORTED_MEDIA' }),
    );
  });

  it('escalates once the download itself is exhausted', async () => {
    const { processor, createTicket } = makeProcessor();

    await processor.onFailed(
      understandableJob({ attemptsMade: 3 }),
      new Error('media id expired'),
    );

    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ escalationReason: 'UNSUPPORTED_MEDIA' }),
    );
  });

  it('opens no ticket for an unsupported attachment — intake already did', async () => {
    const { processor, createTicket, enqueue } = makeProcessor();

    await processor.process(makeJob());

    expect(enqueue).not.toHaveBeenCalled();
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('does not take the worker down when the escalation itself fails', async () => {
    const { processor, enqueue, createTicket } = makeProcessor();
    enqueue.mockRejectedValue(new Error('redis is down'));
    createTicket.mockRejectedValue(new Error('db is down'));

    await expect(
      processor.process(understandableJob()),
    ).resolves.toBeUndefined();
  });
});

describe('MediaDownloadProcessor — Gulf T6 (D9) social channels', () => {
  const CDN_URL = 'https://scontent.xx.fbcdn.net/v/photo.jpg?oh=SIGNATURE';
  const SOCIAL: MediaDownloadJobData = {
    tenantId: 'tenant-a',
    messageId: 'message-7',
    channel: 'instagram',
    channelAccountId: 'ig-1',
    source: { mediaUrl: CDN_URL },
    filename: null,
    understanding: {
      kind: 'image',
      mimeType: '',
      providerMessageId: 'mid.IMG',
      from: 'IGSID-1',
      caption: '',
    },
  };

  function socialJob(data: MediaDownloadJobData = SOCIAL) {
    return {
      id: 'job-7',
      data,
      opts: { attempts: 3 },
      attemptsMade: 1,
    } as Job<MediaDownloadJobData>;
  }

  it('fetches through the social adapter and answers on the same channel', async () => {
    const { processor, adapterFor, downloadMedia, upload, enqueue } =
      makeProcessor();
    downloadMedia.mockResolvedValue({
      content: Buffer.from('jpeg'),
      mimeType: 'image/jpeg',
    });

    await processor.process(socialJob());

    expect(adapterFor).toHaveBeenCalledWith('instagram');
    expect(downloadMedia).toHaveBeenCalledWith('ig-1', { mediaUrl: CDN_URL });
    // Same bucket as WhatsApp; the signed url is never used as the name.
    expect(upload).toHaveBeenCalledWith(
      'tenant-a',
      'attachment',
      expect.any(Buffer),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'instagram',
        channelAccountId: 'ig-1',
        providerMessageId: 'mid.IMG',
        from: 'IGSID-1',
        // Messenger/Instagram declare no mime; the fetched one is used.
        media: {
          messageId: 'message-7',
          kind: 'image',
          mimeType: 'image/jpeg',
          storageKey: 'tenant-a/abc',
        },
      }),
    );
  });

  it('escalates an off-allowlist url to a human without retrying (failure-mode table)', async () => {
    const {
      processor,
      downloadMedia,
      upload,
      markMediaFailed,
      createTicket,
      getOrCreateByPhone,
      getOrCreateConversation,
      enqueue,
    } = makeProcessor();
    downloadMedia.mockRejectedValue(
      new MediaRejectedError('not on the allowlist'),
    );

    await expect(processor.process(socialJob())).resolves.toBeUndefined();

    expect(upload).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(markMediaFailed).toHaveBeenCalledWith(
      'tenant-a',
      'message-7',
      'failed',
      'not on the allowlist',
    );
    expect(createTicket).toHaveBeenCalledWith(
      expect.objectContaining({ escalationReason: 'UNSUPPORTED_MEDIA' }),
    );
    // The ticket lands on the Instagram customer, never a WhatsApp one.
    expect(getOrCreateByPhone).toHaveBeenCalledWith(
      'tenant-a',
      'IGSID-1',
      'instagram',
    );
    expect(getOrCreateConversation).toHaveBeenCalledWith(
      'tenant-a',
      'IGSID-1',
      'ig-1',
      'instagram',
    );
  });

  it('records a streaming size-cap refusal as too_large', async () => {
    const { processor, downloadMedia, markMediaFailed, createTicket } =
      makeProcessor();
    downloadMedia.mockRejectedValue(new MediaTooLargeError(null, 1024));

    await processor.process(socialJob());

    expect(markMediaFailed).toHaveBeenCalledWith(
      'tenant-a',
      'message-7',
      'too_large',
      expect.stringContaining('1024-byte limit'),
    );
    expect(createTicket).toHaveBeenCalled();
  });

  it('opens no extra ticket for a refused document (intake already opened one)', async () => {
    const { processor, downloadMedia, createTicket, markMediaFailed } =
      makeProcessor();
    downloadMedia.mockRejectedValue(new MediaRejectedError('bad type'));

    await processor.process(socialJob({ ...SOCIAL, understanding: undefined }));

    expect(markMediaFailed).toHaveBeenCalled();
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('lets a transient social fetch failure propagate for a retry', async () => {
    const { processor, downloadMedia } = makeProcessor();
    downloadMedia.mockRejectedValue(new Error('HTTP 503'));

    await expect(processor.process(socialJob())).rejects.toThrow('HTTP 503');
  });

  it('escalates on the right channel once retries are exhausted', async () => {
    const { processor, getOrCreateByPhone } = makeProcessor();

    await processor.onFailed(
      { ...socialJob(), attemptsMade: 3 } as Job<MediaDownloadJobData>,
      new Error('HTTP 503'),
    );

    expect(getOrCreateByPhone).toHaveBeenCalledWith(
      'tenant-a',
      'IGSID-1',
      'instagram',
    );
  });
});

describe('MediaDownloadProcessor — jobs queued before Gulf T6', () => {
  const LEGACY: LegacyMediaDownloadJobData = {
    tenantId: 'tenant-a',
    messageId: 'message-1',
    phoneNumberId: 'pn-1',
    mediaId: 'media-123',
    filename: null,
  };

  it('still downloads a pre-T6 WhatsApp job after a deploy', async () => {
    const { processor, adapterFor, downloadMedia, upload } = makeProcessor();

    await processor.process({
      id: 'old-job',
      data: LEGACY,
      opts: { attempts: 3 },
      attemptsMade: 1,
    } as unknown as Job<MediaDownloadJobData>);

    expect(adapterFor).toHaveBeenCalledWith('whatsapp');
    expect(downloadMedia).toHaveBeenCalledWith('pn-1', {
      mediaId: 'media-123',
    });
    expect(upload).toHaveBeenCalledWith(
      'tenant-a',
      'media-123',
      expect.any(Buffer),
    );
  });

  it('refuses job data in neither shape', async () => {
    const { processor, downloadMedia } = makeProcessor();

    await expect(
      processor.process({
        id: 'bad-job',
        data: { tenantId: 'tenant-a' },
        opts: { attempts: 3 },
        attemptsMade: 1,
      } as unknown as Job<MediaDownloadJobData>),
    ).rejects.toThrow(/neither/);
    expect(downloadMedia).not.toHaveBeenCalled();
  });
});
