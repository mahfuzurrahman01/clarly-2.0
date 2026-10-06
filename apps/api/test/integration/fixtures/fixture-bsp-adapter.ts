// Test-only fixture implementing the BspAdapter port (T0's contract) — NOT
// a real vendor adapter. Proves the BSP-agnostic pipeline (T6/T11/T3/T17)
// end-to-end without depending on a real vendor, exactly the way
// Feature 1 shipped a scaffold `echo` tool to prove ToolExecutionModule's
// mechanism ahead of real tools. Signature "verification" here is a
// trivial shared-secret header check, standing in for the real adapter's HMAC scheme.
import { BspAdapter } from '../../../src/modules/whatsapp/ports/bsp-adapter.port';
import type {
  InboundMedia,
  NormalizedInboundMessage,
  SendTemplateMessageParams,
  SendTextMessageParams,
  SendTextMessageResult,
} from '../../../src/modules/whatsapp/ports/bsp-adapter.port';

const FIXTURE_SIGNATURE_HEADER = 'x-fixture-signature';
const FIXTURE_SECRET = 'fixture-shared-secret';

// `extends`, not `implements`: BspAdapter carries a concrete
// verifySubscription() (Meta's handshake) that non-Meta adapters inherit.
export class FixtureBspAdapter extends BspAdapter {
  constructor(private readonly messages: NormalizedInboundMessage[]) {
    super();
  }

  static validHeaders(): Record<string, string> {
    return { [FIXTURE_SIGNATURE_HEADER]: FIXTURE_SECRET };
  }

  verifyWebhookSignature(
    rawBody: string | Buffer,
    headers: Record<string, string>,
  ): boolean {
    void rawBody;
    return headers[FIXTURE_SIGNATURE_HEADER] === FIXTURE_SECRET;
  }

  parseInboundWebhook(rawBody: string | Buffer): NormalizedInboundMessage[] {
    void rawBody;
    return this.messages;
  }

  sendTextMessage(
    params: SendTextMessageParams,
  ): Promise<SendTextMessageResult> {
    void params;
    return Promise.resolve({
      bspMessageId: `wamid.fixture-outbound.${Date.now()}`,
    });
  }

  sendTemplateMessage(
    params: SendTemplateMessageParams,
  ): Promise<SendTextMessageResult> {
    void params;
    return Promise.resolve({
      bspMessageId: `wamid.fixture-template.${Date.now()}`,
    });
  }

  downloadMedia(phoneNumberId: string, mediaId: string): Promise<InboundMedia> {
    void phoneNumberId;
    return Promise.resolve({
      content: Buffer.from(`fixture-media:${mediaId}`),
      mimeType: 'image/jpeg',
    });
  }
}
