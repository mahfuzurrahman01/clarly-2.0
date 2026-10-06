// Clarly 2.0 S3: the `web` channel — the website chat widget.
//
// Unlike WhatsApp and Messenger there is no provider in between: inbound
// messages arrive at WidgetPublicController, which authenticates the visitor
// itself and hands normalized messages to WebhookIngestService.
// ingestMessages(). So the webhook half of this port is deliberately inert
// (no signature to verify, nothing to parse), and "sending" is a no-op that
// mints an id: the reply is already persisted by the caller, and the widget
// reads it by polling. That is what lets the respond path, the human inbox
// and every guardrail treat the widget exactly like any other channel.
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ChannelKind } from './ports/channel-kind';
import {
  ChannelAdapter,
  type InboundMedia,
  type NormalizedInboundMessage,
  type SendResult,
} from './ports/channel-adapter.port';
import { MediaRejectedError } from './ports/media-download.errors';

@Injectable()
export class WebChannelAdapter extends ChannelAdapter {
  readonly channel: ChannelKind = 'web';

  /** The widget never posts provider webhooks; a request claiming to be one is refused. */
  verifyWebhookSignature(): boolean {
    return false;
  }

  parseInboundWebhook(): NormalizedInboundMessage[] {
    return [];
  }

  /** Delivery is "stored for the widget to read" — the caller already wrote the message row. */
  sendText(): Promise<SendResult> {
    return Promise.resolve({ providerMessageId: `web_${randomUUID()}` });
  }

  /** The widget sends text only in this version. */
  downloadMedia(): Promise<InboundMedia> {
    return Promise.reject(
      new MediaRejectedError('The website widget does not send attachments.'),
    );
  }
}
