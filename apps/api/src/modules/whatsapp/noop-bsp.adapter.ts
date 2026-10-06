// Channel (WhatsappModule, T0): the default BspAdapter binding when
// BSP_PROVIDER=none — no Meta app configured in this
// environment. Same pattern as NoopRerankerAdapter/NoopProvisioningAdapter:
// a real no-op, never a placeholder credential.
//
// Unlike rerank (genuinely optional, so its no-op returns a usable result),
// WhatsApp delivery is NOT optional — so this adapter fails closed in both
// directions rather than pretending to work:
//   - verifyWebhookSignature() always returns false, so an exposed webhook
//     endpoint rejects everything while unconfigured instead of accepting
//     unauthenticated payloads.
//   - sendTextMessage() throws, so an undelivered reply surfaces through
//     T11's retry/DLQ/ticket machinery instead of being silently dropped
//     while the turn is recorded as answered.
import { Injectable } from '@nestjs/common';
import { AppLoggerService } from '../core';
import {
  BspAdapter,
  type InboundMedia,
  type NormalizedInboundMessage,
  type SendTemplateMessageParams,
  type SendTextMessageParams,
  type SendTextMessageResult,
} from './ports/bsp-adapter.port';

export class BspNotConfiguredError extends Error {
  constructor() {
    super(
      'No BSP is configured (BSP_PROVIDER=none) — cannot send WhatsApp messages.',
    );
    this.name = 'BspNotConfiguredError';
  }
}

@Injectable()
export class NoopBspAdapter extends BspAdapter {
  constructor(private readonly logger: AppLoggerService) {
    super();
  }

  verifyWebhookSignature(): boolean {
    this.logger.warn(
      'NoopBspAdapter: rejecting an inbound webhook — BSP_PROVIDER=none, so no signature can be verified.',
      NoopBspAdapter.name,
    );
    return false;
  }

  /** Unreachable in practice: WebhookIngestService rejects on the failed signature check before ever parsing. */
  parseInboundWebhook(): NormalizedInboundMessage[] {
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port contract a real adapter needs.
  async sendTextMessage(
    params: SendTextMessageParams,
  ): Promise<SendTextMessageResult> {
    this.logger.warn(
      `NoopBspAdapter: would have sent ${params.body.length} chars to ${params.to} via ${params.phoneNumberId}.`,
      NoopBspAdapter.name,
    );
    throw new BspNotConfiguredError();
  }

  /** Fails closed like the text send: a template that silently went nowhere would leave a human believing they reached a customer they did not. */
  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port contract a real adapter needs.
  async sendTemplateMessage(
    params: SendTemplateMessageParams,
  ): Promise<SendTextMessageResult> {
    this.logger.warn(
      `NoopBspAdapter: would have sent template "${params.templateName}" (${params.language}) to ${params.to} via ${params.phoneNumberId}.`,
      NoopBspAdapter.name,
    );
    throw new BspNotConfiguredError();
  }

  /** Fails closed like both sends: the media row is marked failed rather than left looking like an attachment that is still on its way. */
  // eslint-disable-next-line @typescript-eslint/require-await -- async to satisfy the port contract a real adapter needs.
  async downloadMedia(
    phoneNumberId: string,
    mediaId: string,
  ): Promise<InboundMedia> {
    this.logger.warn(
      `NoopBspAdapter: would have downloaded media ${mediaId} via ${phoneNumberId}.`,
      NoopBspAdapter.name,
    );
    throw new BspNotConfiguredError();
  }
}
