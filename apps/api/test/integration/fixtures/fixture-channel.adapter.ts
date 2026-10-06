// Test-only fixture implementing the shared `ChannelAdapter` port (Feature
// 16's contract) — NOT a real provider adapter.
//
// The channel-agnostic sibling of `FixtureBspAdapter`, and it exists for the
// same reason that one does: to prove the pipeline (T6 dedup, T17 rate
// limiting, T3 media escalation, T11 enqueue) end-to-end without depending on
// a vendor. Feature 16 makes it carry more weight than that, though — an
// instance tagged `messenger` is how the idempotency and channel-agnosticism
// exit criteria are proven for a channel whose real credentials are blocked
// on Meta Tech Provider approval.
//
// Signature "verification" is a trivial shared-secret header check standing in
// for Meta's HMAC, which is tested separately against the real algorithm in
// `webhook-signature.spec.ts`.
import {
  ChannelAdapter,
  type InboundMedia,
  type InboundMediaSource,
  type NormalizedInboundMessage,
  type NormalizedStatusUpdate,
  type SendResult,
  type SendTextParams,
} from '../../../src/modules/channel/ports/channel-adapter.port';
import type { ChannelKind } from '../../../src/modules/channel/ports/channel-kind';

const FIXTURE_SIGNATURE_HEADER = 'x-fixture-signature';
const FIXTURE_SECRET = 'fixture-shared-secret';

export interface RecordedSend extends SendTextParams {
  channel: ChannelKind;
}

export class FixtureChannelAdapter extends ChannelAdapter {
  /** Every send this adapter was asked to make, in order — the assertion surface for "exactly one reply". */
  readonly sends: RecordedSend[] = [];

  constructor(
    readonly channel: ChannelKind,
    private readonly messages: NormalizedInboundMessage[] = [],
    private readonly statusUpdates: NormalizedStatusUpdate[] = [],
  ) {
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

  parseStatusUpdates(rawBody: string | Buffer): NormalizedStatusUpdate[] {
    void rawBody;
    return this.statusUpdates;
  }

  sendText(params: SendTextParams): Promise<SendResult> {
    this.sends.push({ ...params, channel: this.channel });
    return Promise.resolve({
      providerMessageId: `${this.channel}.fixture-outbound.${this.sends.length}`,
    });
  }

  /** Gulf T6: every download this adapter was asked to make. Returns fixed JPEG bytes. */
  readonly downloads: {
    channelAccountId: string;
    source: InboundMediaSource;
  }[] = [];

  downloadMedia(
    channelAccountId: string,
    source: InboundMediaSource,
  ): Promise<InboundMedia> {
    this.downloads.push({ channelAccountId, source });
    return Promise.resolve({
      content: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      mimeType: 'image/jpeg',
    });
  }
}
