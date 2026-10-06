// Channel (WebhookModule, F13; every channel since Gulf T6): worker for the
// `media-download` queue.
//
// Fetches the bytes behind an inbound attachment and stores them, so the
// human handling the escalated ticket can see what the customer actually
// sent, and (F17) so an image or voice note can be answered.
//
// Gulf T6 (D9): the fetch goes through `ChannelAdapter.downloadMedia()`,
// looked up by the channel recorded on the job. WhatsApp's two-hop media-id
// protocol and Messenger/Instagram's CDN-url fetch are the adapters' business;
// this worker only stores, records and hands off. Same bucket for all three.
//
// Same retry/backoff/failed-set-as-DLQ shape as RespondPathProcessor and
// KbIngestProcessor. What matters here is `onFailed`: a job that exhausts its
// attempts flips the row to 'failed' with the reason, rather than leaving it
// at 'pending' forever — a permanent spinner is a worse answer than "this
// attachment could not be retrieved", because only one of them tells the
// person to go ask the customer to resend.
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { AppConfigService, AppLoggerService } from '../core';
import { ChannelRegistry } from '../channel/channel-registry.service';
import type {
  InboundMedia,
  InboundMediaSource,
} from '../channel/ports/channel-adapter.port';
import {
  MediaRejectedError,
  MediaTooLargeError,
} from '../channel/ports/media-download.errors';
import { ConversationService } from '../conversation/conversation.service';
import { CustomerService } from '../customer/customer.service';
import { ObjectStorage } from '../storage/ports/object-storage.port';
import { TicketEscalationService } from '../ticket/ticket-escalation.service';
import {
  type LegacyMediaDownloadJobData,
  MEDIA_DOWNLOAD_QUEUE,
  type MediaDownloadJobData,
  parseMediaDownloadJob,
} from './media-download.queue';
import { RespondPathProducerService } from './respond-path-producer.service';

type QueuedJob = Job<MediaDownloadJobData | LegacyMediaDownloadJobData>;

/** Object name when the customer gave none. A WhatsApp media id is kept (it is what support talks to Meta in); a CDN url is not, because its query string is a signature. */
function storageNameFor(
  filename: string | null,
  source: InboundMediaSource,
): string {
  if (filename) return filename;
  return source.mediaId ?? 'attachment';
}

@Processor(MEDIA_DOWNLOAD_QUEUE)
export class MediaDownloadProcessor extends WorkerHost {
  constructor(
    private readonly channels: ChannelRegistry,
    private readonly storage: ObjectStorage,
    private readonly conversations: ConversationService,
    private readonly config: AppConfigService,
    private readonly logger: AppLoggerService,
    // F17: an understandable attachment continues into a real agent turn from
    // here rather than stopping at "stored for a human". Everything an
    // unsupported attachment does is unchanged.
    private readonly respondPathProducer: RespondPathProducerService,
    private readonly customers: CustomerService,
    private readonly ticketEscalation: TicketEscalationService,
  ) {
    super();
  }

  async process(job: QueuedJob): Promise<void> {
    const data = parseMediaDownloadJob(job.data);
    if (!data) {
      throw new Error(
        `media-download job ${job.id} carries data in neither the current nor the pre-T6 shape.`,
      );
    }
    const { tenantId, messageId } = data;

    const media = await this.download(job, data);
    if (!media) return;

    const stored = await this.storage.upload(
      tenantId,
      storageNameFor(data.filename, data.source),
      media.content,
    );

    await this.conversations.markMediaStored(tenantId, messageId, {
      storageKey: stored.storageKey,
      sizeBytes: stored.sizeBytes,
      mimeType: media.mimeType,
    });

    this.logger.log(
      `media-download job ${job.id} stored ${stored.sizeBytes} bytes for message ${messageId} (${data.channel})`,
      MediaDownloadProcessor.name,
    );

    // F17/A11/A12: the bytes exist now, so the turn can finally run. This is
    // the enqueue WebhookIngestService could not do — it had a media handle and
    // no content. The job goes through the SAME burst-coalescing producer every
    // text message uses (T10), so a photo followed by "how much is this?"
    // lands as one turn rather than two, and every downstream guarantee
    // (advisory lock, idempotency, one reply) is the one that already exists.
    const { understanding } = data;
    if (!understanding) return;

    try {
      await this.respondPathProducer.enqueue({
        tenantId,
        // Gulf T6: the reply goes back out the channel the photo came in on.
        channel: data.channel,
        channelAccountId: data.channelAccountId,
        providerMessageId: understanding.providerMessageId,
        from: understanding.from,
        text: understanding.caption,
        media: {
          messageId,
          kind: understanding.kind,
          // The mime type the FETCH observed, preferred over the one the
          // webhook declared: it describes the bytes we actually hold (and on
          // Messenger/Instagram it is the only one there is).
          mimeType: media.mimeType || understanding.mimeType,
          storageKey: stored.storageKey,
        },
      });
    } catch (error) {
      // The customer's message is stored and visible, but nothing will answer
      // it — a human has to. Escalating rather than rethrowing: a retry would
      // re-download and re-store the same attachment to fix a queue problem.
      await this.escalateUnansweredMedia(
        data,
        `the attachment was stored but the agent turn could not be queued (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  /**
   * Fetches through the channel's adapter and applies the size cap.
   *
   * Returns null when the attachment was refused for good (too large, or
   * rejected by the adapter: an off-allowlist url, a content type we do not
   * keep, a dead url). Those are recorded and escalated HERE and never
   * thrown, because a retry would refuse the same thing again. Anything else
   * the adapter throws is transient and propagates for BullMQ to retry.
   */
  private async download(
    job: QueuedJob,
    data: MediaDownloadJobData,
  ): Promise<InboundMedia | null> {
    const limit = this.config.inboundMediaMaxBytes;
    let media: InboundMedia;
    try {
      media = await this.channels
        .for(data.channel)
        .downloadMedia(data.channelAccountId, data.source);
    } catch (error) {
      if (error instanceof MediaTooLargeError) {
        await this.refuse(job, data, 'too_large', error.message);
        return null;
      }
      if (error instanceof MediaRejectedError) {
        await this.refuse(job, data, 'failed', error.message);
        return null;
      }
      throw error;
    }

    // Also checked after the fetch, because not every adapter can enforce the
    // cap while streaming (WhatsApp's reports no reliable size ahead of time).
    if (media.content.byteLength > limit) {
      const tooLarge = new MediaTooLargeError(media.content.byteLength, limit);
      await this.refuse(job, data, 'too_large', tooLarge.message);
      return null;
    }
    return media;
  }

  /**
   * A permanent refusal: the row says why, and an attachment the agent was
   * going to answer (no ticket behind it — intake opened none) is escalated,
   * which is the "off-allowlist url escalates to a human" row of D9's
   * failure-mode table.
   */
  private async refuse(
    job: QueuedJob,
    data: MediaDownloadJobData,
    status: 'too_large' | 'failed',
    reason: string,
  ): Promise<void> {
    await this.conversations.markMediaFailed(
      data.tenantId,
      data.messageId,
      status,
      reason,
    );
    this.logger.warn(
      `media-download job ${job.id} refused the ${data.channel} attachment on message ${data.messageId}: ${reason}`,
      MediaDownloadProcessor.name,
    );
    await this.escalateUnansweredMedia(
      data,
      `the attachment could not be kept: ${reason}`,
    );
  }

  /**
   * F17: the one place a to-be-answered attachment turns back into a human
   * handoff. Intake opens no ticket for these (that is the whole point of the
   * amended T3 matrix), so every path that ends without an agent turn must come
   * through here. `escalation_reason` is decided at this call site and never
   * inferred downstream (D13).
   *
   * Never throws: this runs inside a worker, and a failure to escalate must not
   * take the process down on top of the message it was trying to rescue.
   */
  private async escalateUnansweredMedia(
    data: MediaDownloadJobData,
    why: string,
  ): Promise<void> {
    const { understanding, tenantId, messageId, channel } = data;
    if (!understanding) return;

    try {
      // Channel-scoped identity (F16): a PSID must land on the Messenger
      // customer and conversation, never on a WhatsApp one.
      const customer = await this.customers.getOrCreateByPhone(
        tenantId,
        understanding.from,
        channel,
      );
      const conversation = await this.conversations.getOrCreateConversation(
        tenantId,
        understanding.from,
        data.channelAccountId,
        channel,
      );
      await this.ticketEscalation.createTicket({
        tenantId,
        customerId: customer.id,
        conversationId: conversation.id,
        escalationReason: 'UNSUPPORTED_MEDIA',
        note: `The customer sent a ${understanding.kind} message on ${channel} (messageId=${messageId}) the agent could not answer: ${why}.`,
      });
    } catch (error) {
      this.logger.error(
        `could not escalate unanswerable media on message ${messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        undefined,
        MediaDownloadProcessor.name,
      );
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: QueuedJob | undefined, error: Error): Promise<void> {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    const exhausted = job.attemptsMade >= maxAttempts;

    this.logger.warn(
      `media-download job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}): ${error.message}`,
      MediaDownloadProcessor.name,
    );

    if (!exhausted) return;

    // Best-effort: if even this write fails the row stays 'pending', which is
    // wrong but recoverable, and throwing here would take the worker down
    // over a message that already failed.
    try {
      await this.conversations.markMediaFailed(
        job.data.tenantId,
        job.data.messageId,
        'failed',
        error.message,
      );
    } catch (markError) {
      this.logger.error(
        `media-download job ${job.id} could not record its own failure on message ${job.data.messageId}: ${
          markError instanceof Error ? markError.message : String(markError)
        }`,
        MediaDownloadProcessor.name,
      );
    }

    // F17: same rule as the refusal branch — an attachment the agent was going
    // to answer has no ticket behind it, so an exhausted download must produce
    // one here or the customer's message is lost.
    const data = parseMediaDownloadJob(job.data);
    if (!data) return;
    await this.escalateUnansweredMedia(
      data,
      `the attachment could not be retrieved after ${maxAttempts} attempts (${error.message})`,
    );
  }

  // Without this, a Redis blip on this worker's connection is an unhandled
  // EventEmitter 'error' — @nestjs/bullmq never attaches a default listener
  // — which crashes the whole process instead of just this queue degrading.
  @OnWorkerEvent('error')
  onError(error: Error): void {
    this.logger.error(
      `media-download worker connection error: ${error.message}`,
      error.stack,
      MediaDownloadProcessor.name,
    );
  }
}
