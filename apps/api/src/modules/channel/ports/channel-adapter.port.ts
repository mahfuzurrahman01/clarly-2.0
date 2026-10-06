// Channel (ChannelModule, Feature 16): the ONE port every messaging channel
// implements — WhatsApp (via T0's `BspAdapter`, adapted) and Meta's
// Messenger/Instagram DM (`MetaChannelAdapter`).
//
// Why a second port rather than widening `BspAdapter`: `BspAdapter` is a
// *vendor* port. It speaks WhatsApp Business API vocabulary that has no
// Messenger/Instagram counterpart at all — `phone_number_id`, WABA
// templates, `wabaId`. Widening it would have forced every Meta concept
// through WhatsApp-shaped fields and put exactly the per-channel branching
// Feature 16 exists to prevent inside the adapters. So `BspAdapter` stays
// untouched and WhatsApp reaches this port through `WhatsappChannelAdapter`,
// a plain Adapter-pattern translation.
//
// The vocabulary here is deliberately channel-neutral:
//
//   phone_number_id / page_id / ig_id   -> channelAccountId
//   wamid.* / mid.*                     -> providerMessageId
//   E.164 wa_id / PSID / IGSID          -> from
//
// Nothing downstream of ingest (WebhookIngestService, the respond-path
// queue, ConversationModule, AgentModule) sees a channel-specific field
// again — it sees `channel` as data, and looks the right adapter/policy up
// by it. That lookup is the whole reason the exit criterion "zero
// channel-specific branches in AgentModule" is structurally true rather
// than merely observed.
import type { ChannelKind } from './channel-kind';

export type { ChannelKind };

/** Same fixed, provider-agnostic media classification T3 defined on `BspAdapter`. Reused verbatim rather than re-declared: a Messenger image and a WhatsApp image escalate for the same reason and must not be two enums. */
export type InboundMessageType =
  'text' | 'image' | 'voice' | 'document' | 'unsupported';

/**
 * How the provider lets us fetch an attachment (Gulf T6, D9). Exactly one of
 * the two, and the name says which, because the two are dereferenced on
 * different auth models:
 *   - `mediaId`: WhatsApp. Two hops with the number's bearer token.
 *   - `mediaUrl`: Messenger/Instagram. A signed Meta CDN url, fetched once
 *     with no credentials, and only from the D9 host allowlist.
 * Only the channel's own adapter interprets it.
 */
export type InboundMediaSource =
  | { readonly mediaId: string; readonly mediaUrl?: never }
  | { readonly mediaUrl: string; readonly mediaId?: never };

export type InboundMediaDescriptor = InboundMediaSource & {
  /** As the provider declares it; null when it declares none (Messenger/Instagram never do). Attacker-influenced either way. */
  mimeType: string | null;
  filename: string | null;
  caption: string | null;
};

/** The handle as one string, for the `messages.media_id` column (the id, or the CDN url). */
export function mediaHandleOf(source: InboundMediaSource): string {
  return source.mediaId ?? source.mediaUrl ?? '';
}

/** The media handle part of a descriptor, without its metadata. */
export function mediaSourceOf(source: InboundMediaSource): InboundMediaSource {
  return source.mediaId !== undefined
    ? { mediaId: source.mediaId }
    : { mediaUrl: source.mediaUrl ?? '' };
}

/** Bytes fetched from the provider, with the content type it served them as. */
export interface InboundMedia {
  content: Buffer;
  mimeType: string | null;
}

export interface NormalizedInboundMessage {
  /** Which channel this arrived on. Data, never a branch: callers use it to look up the adapter/policy, never to `if`. */
  channel: ChannelKind;
  /** The tenant-connected account it arrived on — WhatsApp `phone_number_id`, Facebook page id, or Instagram professional-account id. Resolves to a tenant. */
  channelAccountId: string;
  /** The provider's own message id — WhatsApp `wamid.*`, Messenger/Instagram `mid.*`. T6's dedup key; redelivered verbatim on a provider retry. */
  providerMessageId: string;
  /** The customer's channel-scoped identity: a WhatsApp id, a Messenger PSID, or an Instagram IGSID. Never assume it is a phone number. */
  from: string;
  type: InboundMessageType;
  text?: string;
  media?: InboundMediaDescriptor;
  receivedAt: Date;
}

/** Delivery lifecycle, normalized. Mirrors `messages.delivery_status`. */
export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface NormalizedStatusUpdate {
  channel: ChannelKind;
  channelAccountId: string;
  providerMessageId: string;
  status: DeliveryStatus;
  error: string | null;
  occurredAt: Date;
}

/**
 * Gulf T3 (D13): a message the business itself sent outside this system
 * (WhatsApp Business app on a coexistence number), mirrored to us so the
 * transcript is complete. Human-sent outbound: stored, never answered.
 */
export interface NormalizedOutboundEcho {
  channel: ChannelKind;
  channelAccountId: string;
  providerMessageId: string;
  /** The customer it was sent to. */
  to: string;
  type: InboundMessageType;
  text?: string;
  media?: InboundMediaDescriptor;
  sentAt: Date;
}

export interface SendTextParams {
  channelAccountId: string;
  to: string;
  body: string;
  /**
   * The out-of-window exception this send is claiming, when the messaging
   * window has shut — resolved by `ChannelPolicy`, never guessed here.
   *
   * WhatsApp ignores it (its only out-of-window path is a template, which
   * is a different call). Messenger/Instagram put it on the wire as
   * `messaging_type: MESSAGE_TAG` + `tag`.
   */
  tag?: string;
}

export interface SendResult {
  providerMessageId: string;
}

/**
 * Abstract class rather than an interface so it doubles as its own NestJS
 * DI token — the same pattern D1's `LlmProvider`, D3's `VectorStore` and
 * T0's `BspAdapter` already use.
 */
export abstract class ChannelAdapter {
  /** Which channel this binding serves. `ChannelRegistry` indexes on it. */
  abstract readonly channel: ChannelKind;

  /** Verifies the request really came from the provider, before any parsing of untrusted bytes. */
  abstract verifyWebhookSignature(
    rawBody: string | Buffer,
    headers: Record<string, string>,
  ): boolean;

  /** One webhook POST can carry many messages. Returns all of them, normalized. */
  abstract parseInboundWebhook(
    rawBody: string | Buffer,
  ): NormalizedInboundMessage[];

  /**
   * Delivery/read receipts for messages we sent. Concrete and defaulting to
   * none, same as `BspAdapter.parseStatusUpdates` — a channel with no status
   * callbacks stays a valid binding rather than being forced to lie.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the default ignores the body; bindings with status callbacks override.
  parseStatusUpdates(rawBody: string | Buffer): NormalizedStatusUpdate[] {
    return [];
  }

  /**
   * Gulf T3 (D13): business-sent echoes. Concrete and defaulting to none;
   * only WhatsApp (coexistence numbers) has them today.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the default ignores the body; bindings with echoes override.
  parseOutboundEchoes(rawBody: string | Buffer): NormalizedOutboundEcho[] {
    return [];
  }

  abstract sendText(params: SendTextParams): Promise<SendResult>;

  /**
   * Gulf T6 (D9): fetches an inbound attachment's bytes. Called by the
   * media-download worker, never on the webhook path.
   *
   * `channelAccountId` is the account the message arrived on (WhatsApp needs
   * it for the per-number token; the social CDN fetch carries no credentials).
   *
   * @throws MediaRejectedError never retryable: the handle must not be
   *   fetched (wrong kind, off-allowlist url) or what came back is not kept.
   * @throws MediaTooLargeError over `INBOUND_MEDIA_MAX_BYTES`.
   * Anything else is treated as transient and retried.
   */
  abstract downloadMedia(
    channelAccountId: string,
    source: InboundMediaSource,
  ): Promise<InboundMedia>;

  /**
   * The provider's webhook subscription handshake (Meta echoes
   * `hub.challenge`). Concrete, defaulting to null = reject, because it is a
   * Meta-family ceremony no other provider has.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the default rejects; only Meta-family bindings read the query.
  verifySubscription(query: Record<string, string>): string | null {
    return null;
  }
}
