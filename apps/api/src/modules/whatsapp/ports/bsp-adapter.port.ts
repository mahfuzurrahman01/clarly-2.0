// Channel (WhatsappModule): BspAdapter port (T0 architect deliverable).
// Drafted against the Meta Cloud API webhook/send contract (see
// docs/decisions/T0-bsp-selection.md). Since D14 (Gulf T2) the only real
// binding is MetaCloudAdapter; the port stays so callers never depend on a
// vendor class and tests can bind a fixture. `apps/api/test/integration/
// webhook-ingest.integration-spec.ts` uses a small in-repo test fixture
// implementing this port to prove the provider-agnostic pipeline
// (T6/T11/T3/T17) end-to-end without depending on a real vendor.
//
// media detection (T3): NormalizedInboundMessage['type'] IS the media
// classification — parseInboundWebhook() maps whatever the wire format
// calls it (Meta: "text"/"image"/"audio"/"document"/"video"/"sticker"/...)
// onto this fixed, BSP-agnostic set.
export type InboundMessageType =
  'text' | 'image' | 'voice' | 'document' | 'unsupported';

/**
 * The media attached to a non-text inbound message (F13).
 *
 * The bytes are NOT here. A BSP hands out a media id and expects a separate,
 * authenticated fetch — which is far too slow to do on the webhook path
 * (T11's <1s ACK budget), so ingest records the descriptor and a worker
 * fetches the bytes afterwards.
 */
export interface InboundMediaDescriptor {
  /** The BSP's media id. Opaque, and short-lived on Meta's side — fetch it promptly or it expires. */
  mediaId: string;
  /** As the BSP reports it. Never trusted for rendering decisions on its own — it is attacker-influenced. */
  mimeType: string | null;
  /** Present for documents. Metadata only: never used to build a storage path. */
  filename: string | null;
  /** The text a customer typed alongside the image/video. Genuinely part of the message and lost entirely if not captured here. */
  caption: string | null;
}

export interface NormalizedInboundMessage {
  /** Meta Cloud API's `phone_number_id` — the WABA number the message arrived on, resolves to a tenant via whatsapp_numbers (T6). */
  phoneNumberId: string;
  /** The BSP's message id (Meta: `wamid.*`) — T6's dedup key. Redelivered verbatim on webhook retry. */
  bspMessageId: string;
  /** The customer's WhatsApp ID (E.164-ish, BSP-specific formatting). */
  from: string;
  type: InboundMessageType;
  /** Present only when type === 'text'. */
  text?: string;
  /** Present for image/voice/document, and for an unsupported type that still carried a media id (video, sticker). Absent for text. */
  media?: InboundMediaDescriptor;
  receivedAt: Date;
}

/** BSP delivery lifecycle, normalized. Mirrors messages.delivery_status. */
export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

/**
 * A status callback for a message WE sent. Meta delivers these on the same
 * webhook endpoint as inbound messages, in a `statuses` array — which the
 * inbound parser deliberately ignores, so they need their own parse.
 */
export interface NormalizedStatusUpdate {
  phoneNumberId: string;
  /** The id returned by the original send — the only key linking this back to a stored message. */
  bspMessageId: string;
  status: DeliveryStatus;
  /** Vendor error detail for status='failed'; null otherwise. */
  error: string | null;
  occurredAt: Date;
}

/**
 * Gulf T3 (D13): a message the BUSINESS sent from the WhatsApp Business app
 * on a coexistence number. Meta mirrors it to us as an `smb_message_echoes`
 * webhook so the transcript stays complete. It is human-sent outbound
 * traffic: stored, never answered.
 */
export interface NormalizedMessageEcho {
  /** The business number it was sent from. Resolves to a tenant. */
  phoneNumberId: string;
  /** Meta's `wamid.*` for the echoed message. Dedup key. */
  bspMessageId: string;
  /** The customer it was sent TO (the conversation's customer). */
  to: string;
  type: InboundMessageType;
  /** Present only when type === 'text'. */
  text?: string;
  /** Descriptor of an echoed attachment; the bytes are not fetched. */
  media?: InboundMediaDescriptor;
  sentAt: Date;
}

/** Bytes fetched from the BSP, with whatever it says about them. */
export interface InboundMedia {
  content: Buffer;
  /** The BSP's own content type, which may differ from what the webhook reported. */
  mimeType: string | null;
}

export interface SendTextMessageParams {
  phoneNumberId: string;
  to: string;
  body: string;
}

export interface SendTextMessageResult {
  bspMessageId: string;
}

/**
 * A pre-registered template send (F12) — the ONLY thing WhatsApp accepts once
 * the 24-hour customer service window has shut.
 *
 * `templateName` and `language` are Meta's identity for an approved template,
 * not ours: they must match what the tenant registered in their WhatsApp
 * Business account exactly, or the send fails with "template not found" and
 * nothing indicates which end is wrong.
 */
export interface SendTemplateMessageParams {
  phoneNumberId: string;
  to: string;
  templateName: string;
  /** Meta language code (`en`, `en_US`, `bn`). One name in two languages is two templates to Meta. */
  language: string;
  /**
   * Body placeholder values in `{{1}}..{{n}}` order. Positional, because the
   * wire format is: Meta's `components[].parameters` is an ordered array with
   * no keys, so a named mapping would put a silent off-by-one between what a
   * tenant authored and what a customer reads.
   */
  bodyParameters: string[];
}

/**
 * A template being registered with the BSP for review (F12 submission).
 *
 * `bodyExamples` is not decoration: Meta rejects a template whose body has
 * `{{n}}` placeholders and no sample values, because a human reviewer cannot
 * judge "Your order {{1}} ships {{2}}" without seeing what fills it. The
 * caller supplies one example per placeholder, in position order.
 */
export interface SubmitTemplateParams {
  phoneNumberId: string;
  /** Lowercase, underscores only — Meta's own constraint on template names. */
  name: string;
  language: string;
  category: string;
  body: string;
  /** One sample per `{{n}}`, in position order. Empty when the body has no placeholders. */
  bodyExamples: string[];
}

/** What a BSP returns from a submission — the review has been *accepted*, not passed. */
export interface BspTemplateSubmission {
  /** The BSP's own id for the template, if it issues one. Stored for nothing today; kept because a rejection appeal needs it. */
  providerTemplateId: string | null;
  /** The BSP's own value, uppercase and unmapped — almost always `PENDING`. The caller owns the mapping, same as `BspTemplateStatus.status`. */
  status: string;
  category: string | null;
}

/** What a BSP reports about a template's review state. Mirrors Meta's `/message_templates` listing. */
export interface BspTemplateStatus {
  name: string;
  language: string;
  /** Meta's own value (`APPROVED`, `REJECTED`, `PENDING`, `PAUSED`, `DISABLED`), uppercase and unmapped — the caller owns the mapping. */
  status: string;
  category: string | null;
  /** Meta's rejection reason, when it gives one. */
  reason: string | null;
}

/**
 * Abstract class (not a bare interface) so it doubles as its own NestJS DI
 * token, same pattern as D1's LlmProvider / D3's VectorStore — a concrete
 * adapter is bound by WhatsappModule's factory (MetaCloudAdapter or the
 * no-op); every caller injects this type only, never a vendor-specific
 * class.
 */
export abstract class BspAdapter {
  /** Verifies the webhook request actually came from the BSP (signature header check) before any parsing happens. */
  abstract verifyWebhookSignature(
    rawBody: string | Buffer,
    headers: Record<string, string>,
  ): boolean;

  /** A single webhook POST can carry multiple messages (batched entries) — returns all of them, normalized. */
  abstract parseInboundWebhook(
    rawBody: string | Buffer,
  ): NormalizedInboundMessage[];

  /**
   * Delivery/read receipts for messages we sent. Concrete (not abstract)
   * and defaulting to none so an adapter that has no status callbacks — or
   * has not implemented them yet — stays valid; both Meta-shaped adapters
   * override it via the shared parser.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the default ignores the body; Meta-shaped adapters parse it.
  parseStatusUpdates(rawBody: string | Buffer): NormalizedStatusUpdate[] {
    return [];
  }

  /**
   * Gulf T3 (D13): WhatsApp Business app echoes on a coexistence number.
   * Concrete and defaulting to none, same as parseStatusUpdates: only
   * MetaCloudAdapter receives them.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the default ignores the body; MetaCloudAdapter parses it.
  parseMessageEchoes(rawBody: string | Buffer): NormalizedMessageEcho[] {
    return [];
  }

  abstract sendTextMessage(
    params: SendTextMessageParams,
  ): Promise<SendTextMessageResult>;

  /**
   * Sends an approved template (F12). Abstract rather than defaulted: every
   * real BSP supports templates, and a default that quietly did nothing would
   * turn "the customer never heard back after a day" into a silent failure —
   * which is exactly the class of bug this feature exists to close.
   */
  abstract sendTemplateMessage(
    params: SendTemplateMessageParams,
  ): Promise<SendTextMessageResult>;

  /**
   * Fetches the bytes behind an inbound media id (F13).
   *
   * Abstract for the same reason `sendTemplateMessage` is: every BSP has a
   * media endpoint, and a default that returned nothing would leave a human
   * looking at an escalated image ticket with no image and no error — the
   * exact blindness this exists to remove.
   *
   * `phoneNumberId` is needed for the credential lookup, not for the fetch
   * itself: media is authenticated with the same per-number token a send is.
   */
  abstract downloadMedia(
    phoneNumberId: string,
    mediaId: string,
  ): Promise<InboundMedia>;

  /**
   * The templates this number's WhatsApp Business account has registered,
   * with their review state — used to reconcile what a tenant told us against
   * what Meta actually approved.
   *
   * Concrete and defaulting to null (not an empty array) because "this
   * adapter cannot tell you" and "this account has no templates" must not
   * look the same: the first must leave a stored status untouched, the second
   * would mean marking every template as gone.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the default reports nothing; only adapters with a template listing API override it.
  listTemplates(phoneNumberId: string): Promise<BspTemplateStatus[] | null> {
    return Promise.resolve(null);
  }

  /**
   * Registers a template with the BSP for review (F12).
   *
   * Without this, `approvalStatus` can never leave `pending`: nothing else in
   * the system tells Meta a template exists, `listTemplates` only reads back
   * what is already registered, and the send path refuses anything not
   * `approved`. So the whole outside-the-24-hour-window path stays shut.
   *
   * Concrete and defaulting to null, matching `listTemplates` rather than
   * `sendTemplateMessage`, and for the same reason: "this adapter cannot
   * submit" and "the submission was accepted" must not look alike. A default
   * that threw would make an unsupported BSP indistinguishable from a broken
   * one; a default that returned a fake `PENDING` would be the silently-
   * succeeding placeholder this codebase refuses everywhere else. Null lets
   * the caller leave the stored status untouched and say so out loud.
   *
   * Only MetaCloudAdapter overrides it.
   */
  submitTemplate(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the default reports nothing; only adapters with a template creation API override it.
    params: SubmitTemplateParams,
  ): Promise<BspTemplateSubmission | null> {
    return Promise.resolve(null);
  }

  /**
   * Meta's webhook subscription handshake: the console will not register a
   * callback URL until a GET to it echoes back `hub.challenge`, gated on a
   * shared `hub.verify_token`. Concrete (not abstract) and defaulting to
   * null because this is a Meta-only ceremony — the no-op binding inherits
   * the default, so a GET against an unconfigured deployment is simply
   * rejected.
   *
   * @returns the challenge string to echo, or null to reject with 403.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the default rejects unconditionally; only MetaCloudAdapter reads the query.
  verifySubscription(query: Record<string, string>): string | null {
    return null;
  }
}
