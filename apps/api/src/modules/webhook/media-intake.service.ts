// Channel (WebhookModule, F13): what happens to a non-text message on the
// webhook path.
//
// Extracted from WebhookIngestService rather than inlined there, because that
// service is an ordering contract — verify, resolve, rate-limit, dedup,
// escalate-or-enqueue — and each step reads as one line for a reason. This is
// the body of one of those lines.
//
// Two things happen here, and only the second is new work per message:
//   1. the message is RECORDED, which it previously never was — a non-text
//      message produced no `messages` row at all, so the transcript did not
//      say "the customer sent a photo", it said nothing;
//   2. the bytes are QUEUED, never fetched inline. A media fetch is two
//      authenticated round-trips and several megabytes; doing it here would
//      blow T11's <1s ACK budget and have the BSP redeliver the webhook.
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { AppLoggerService } from '../core';
import { ConversationService } from '../conversation/conversation.service';
import {
  type InboundMessageType,
  mediaHandleOf,
  mediaSourceOf,
  type NormalizedInboundMessage,
} from '../channel/ports/channel-adapter.port';
import {
  MEDIA_DOWNLOAD_QUEUE,
  type MediaDownloadJobData,
} from './media-download.queue';

/** What the transcript says when the customer sent no caption. Words, not an empty string: prompt assembly and the rolling summary both read this column. */
const PLACEHOLDER: Record<InboundMessageType, string> = {
  text: '[message]',
  image: '[the customer sent an image]',
  voice: '[the customer sent a voice message]',
  document: '[the customer sent a document]',
  unsupported: '[the customer sent an attachment this agent cannot read]',
};

@Injectable()
export class MediaIntakeService {
  constructor(
    private readonly conversations: ConversationService,
    @InjectQueue(MEDIA_DOWNLOAD_QUEUE)
    private readonly queue: Queue<MediaDownloadJobData>,
    private readonly logger: AppLoggerService,
  ) {}

  /**
   * Records the message and queues its bytes.
   *
   * @returns the `messages` row id plus whether the download was actually
   *   queued, or null when the message carried no media descriptor at all (an
   *   interactive reply, a location, a reaction) — those still escalate, they
   *   just have nothing to fetch.
   *
   *   `queued` matters as of F17: an attachment the agent is meant to ANSWER
   *   has no escalation ticket behind it, so a queue outage that loses the
   *   download job would lose the customer's message entirely. The caller
   *   escalates on `queued: false`; before F17 a ticket already existed either
   *   way, which is why this used to return the id alone.
   */
  async record(
    tenantId: string,
    conversationId: string,
    message: NormalizedInboundMessage,
    /**
     * F17: the modality the agent will answer this attachment as, when it is
     * one of the understood ones. Passed IN by WebhookIngestService rather
     * than re-derived here: the escalation matrix decides it once, at the call
     * site that also decides whether to open a ticket, and this service must
     * not be able to disagree with that decision.
     */
    understandAs?: 'image' | 'voice' | null,
  ): Promise<{ messageId: string; queued: boolean } | null> {
    if (!message.media) return null;

    const messageId = await this.conversations.recordInboundMediaMessage({
      tenantId,
      conversationId,
      providerMessageId: message.providerMessageId,
      // The caption is the customer's own words and is genuinely part of the
      // message — dropping it in favour of a placeholder would lose the half
      // of it that is readable.
      content: message.media.caption?.trim()
        ? message.media.caption.trim()
        : PLACEHOLDER[message.type],
      // The WhatsApp media id, or (Gulf T6) the Messenger/Instagram CDN url.
      mediaId: mediaHandleOf(message.media),
      mimeType: message.media.mimeType,
      filename: message.media.filename,
      receivedAt: message.receivedAt,
    });

    let queued = true;
    try {
      await this.queue.add(MEDIA_DOWNLOAD_QUEUE, {
        tenantId,
        messageId,
        // Gulf T6 (D9): every channel queues. The worker looks the adapter up
        // by `channel`, and the social adapter fetches only allowlisted CDN
        // urls, escalating anything else to a human.
        channel: message.channel,
        channelAccountId: message.channelAccountId,
        source: mediaSourceOf(message.media),
        filename: message.media.filename,
        ...(understandAs
          ? {
              understanding: {
                kind: understandAs,
                mimeType: message.media.mimeType ?? '',
                providerMessageId: message.providerMessageId,
                from: message.from,
                caption: message.media.caption?.trim() ?? '',
              },
            }
          : {}),
      });
    } catch (error) {
      queued = false;
      // Swallowed, and the row is left 'pending': the escalation ticket is
      // the thing that must not be lost, and a queue outage should not stop a
      // customer's message from reaching a human. The failure is logged
      // rather than surfaced, because the person on the ticket still sees
      // that an attachment exists and is not here yet.
      this.logger.error(
        `could not queue media download for message ${messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        MediaIntakeService.name,
      );
    }

    return { messageId, queued };
  }
}
