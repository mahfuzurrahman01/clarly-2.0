// Channel (ChannelModule, Feature 16): WhatsApp's binding onto the shared
// `ChannelAdapter` port — a textbook Adapter, translating T0's vendor-shaped
// `BspAdapter` into channel-neutral vocabulary and nothing else.
//
// Deliberately thin, and deliberately NOT a rewrite of the WhatsApp
// adapter: `MetaCloudAdapter` and the shared Meta
// envelope parser are the most security-sensitive, most-tested code in the
// channel layer, and Feature 16 must not put a single edit into them to add
// Instagram. The whole cost of WhatsApp joining the new port is this file.
//
// Field mapping (the only thing here):
//     phoneNumberId  -> channelAccountId
//     bspMessageId   -> providerMessageId
//     (implicit)     -> channel: 'whatsapp'
//
// `SendTextParams.tag` is ignored, correctly: WhatsApp has no tag mechanism
// (see WhatsappChannelPolicy.outOfWindowTag), and a caller that needs to
// reach a WhatsApp customer outside the window sends a template through
// BspAdapter.sendTemplateMessage, which is a different call with different
// approval requirements — not a tagged text send.
import { Injectable } from '@nestjs/common';
import { BspAdapter } from '../whatsapp/ports/bsp-adapter.port';
import {
  ChannelAdapter,
  type InboundMedia,
  type InboundMediaSource,
  type NormalizedInboundMessage,
  type NormalizedOutboundEcho,
  type NormalizedStatusUpdate,
  type SendResult,
  type SendTextParams,
} from './ports/channel-adapter.port';
import type { ChannelKind } from './ports/channel-kind';
import { MediaRejectedError } from './ports/media-download.errors';

@Injectable()
export class WhatsappChannelAdapter extends ChannelAdapter {
  readonly channel: ChannelKind = 'whatsapp';

  constructor(private readonly bsp: BspAdapter) {
    super();
  }

  verifyWebhookSignature(
    rawBody: string | Buffer,
    headers: Record<string, string>,
  ): boolean {
    return this.bsp.verifyWebhookSignature(rawBody, headers);
  }

  parseInboundWebhook(rawBody: string | Buffer): NormalizedInboundMessage[] {
    return this.bsp.parseInboundWebhook(rawBody).map((message) => ({
      channel: this.channel,
      channelAccountId: message.phoneNumberId,
      providerMessageId: message.bspMessageId,
      from: message.from,
      type: message.type,
      text: message.text,
      media: message.media,
      receivedAt: message.receivedAt,
    }));
  }

  parseStatusUpdates(rawBody: string | Buffer): NormalizedStatusUpdate[] {
    return this.bsp.parseStatusUpdates(rawBody).map((update) => ({
      channel: this.channel,
      channelAccountId: update.phoneNumberId,
      providerMessageId: update.bspMessageId,
      status: update.status,
      error: update.error,
      occurredAt: update.occurredAt,
    }));
  }

  parseOutboundEchoes(rawBody: string | Buffer): NormalizedOutboundEcho[] {
    return this.bsp.parseMessageEchoes(rawBody).map((echo) => ({
      channel: this.channel,
      channelAccountId: echo.phoneNumberId,
      providerMessageId: echo.bspMessageId,
      to: echo.to,
      type: echo.type,
      text: echo.text,
      media: echo.media,
      sentAt: echo.sentAt,
    }));
  }

  async sendText(params: SendTextParams): Promise<SendResult> {
    const { bspMessageId } = await this.bsp.sendTextMessage({
      phoneNumberId: params.channelAccountId,
      to: params.to,
      body: params.body,
    });
    return { providerMessageId: bspMessageId };
  }

  /**
   * Gulf T6: WhatsApp's two-hop media-id download, unchanged, reached through
   * the shared port (critical regression #3). A url handle is refused: a
   * WhatsApp attachment is only ever fetched by id with the number's token.
   */
  async downloadMedia(
    channelAccountId: string,
    source: InboundMediaSource,
  ): Promise<InboundMedia> {
    if (source.mediaId === undefined) {
      throw new MediaRejectedError(
        'A WhatsApp attachment must be fetched by media id, not by url.',
      );
    }
    return this.bsp.downloadMedia(channelAccountId, source.mediaId);
  }

  verifySubscription(query: Record<string, string>): string | null {
    return this.bsp.verifySubscription(query);
  }
}
