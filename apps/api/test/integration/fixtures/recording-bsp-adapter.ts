// Outbound half of the BspAdapter port, for suites that drive the real
// respond path but have no BSP account.
//
// Without an override, `RespondPathProcessor.deliverAnswer()` calls the
// configured real adapter, the send fails, and the processor (correctly)
// turns that into a TOOL_FAILURE ticket and an `error` agent_runs row — so a
// suite asserting on a NORMAL turn ends up asserting against the
// delivery-failure path instead, for reasons that have nothing to do with
// what it is testing. This adapter makes delivery deterministic and records
// what was sent, so the last link of the loop can actually be asserted on
// rather than merely tolerated.
import {
  BspAdapter,
  type InboundMedia,
  type NormalizedInboundMessage,
  type SendTemplateMessageParams,
  type SendTextMessageParams,
  type SendTextMessageResult,
} from '../../../src/modules/whatsapp/ports/bsp-adapter.port';

export class RecordingBspAdapter extends BspAdapter {
  readonly sent: SendTextMessageParams[] = [];
  /** Template sends land here rather than in `sent`: a suite asserting "the agent replied" must not pass because a template went out instead. */
  readonly sentTemplates: SendTemplateMessageParams[] = [];

  verifyWebhookSignature(): boolean {
    return true;
  }

  parseInboundWebhook(): NormalizedInboundMessage[] {
    return [];
  }

  sendTextMessage(
    params: SendTextMessageParams,
  ): Promise<SendTextMessageResult> {
    this.sent.push(params);
    return Promise.resolve({
      bspMessageId: `wamid.recorded.${this.sent.length}`,
    });
  }

  sendTemplateMessage(
    params: SendTemplateMessageParams,
  ): Promise<SendTextMessageResult> {
    this.sentTemplates.push(params);
    return Promise.resolve({
      bspMessageId: `wamid.recorded-template.${this.sentTemplates.length}`,
    });
  }

  downloadMedia(phoneNumberId: string, mediaId: string): Promise<InboundMedia> {
    void phoneNumberId;
    return Promise.resolve({
      content: Buffer.from(`recorded-media:${mediaId}`),
      mimeType: 'image/jpeg',
    });
  }
}
