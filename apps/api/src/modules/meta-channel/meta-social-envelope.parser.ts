// Channel (MetaChannelModule, Feature 16): the Messenger / Instagram DM
// webhook wire format.
//
// A SEPARATE parser from `whatsapp/meta-envelope.parser.ts`, and that is not
// duplication. The two envelopes share only the `{ object, entry[] }`
// wrapper: WhatsApp puts messages under `entry[].changes[].value.messages[]`
// with a `metadata.phone_number_id`, while Messenger/Instagram put them
// under `entry[].messaging[]` with the account id on `entry[].id` and a
// completely different message body (`message.mid`, `message.text`,
// `message.attachments[]`, `message.is_echo`). Forcing one schema over both
// would mean a parser full of optionals where every field is "present for
// one product, absent for the other" — the opposite of the strictness this
// layer needs, since it is the most untrusted input the system accepts.
//
// Parsed with zod rather than cast, same as its WhatsApp counterpart, and
// with the same deliberate asymmetry: STRICT at the envelope (a malformed
// body is a clean rejection, never a downstream `undefined`), LENIENT at the
// leaf (an unknown attachment type degrades to 'unsupported', never throws
// away a whole webhook carrying real customer messages).
import { z } from 'zod';
import type {
  InboundMediaDescriptor,
  InboundMessageType,
  NormalizedInboundMessage,
  NormalizedStatusUpdate,
} from '../channel/ports/channel-adapter.port';
import type { ChannelKind } from '../channel/ports/channel-kind';

/** Meta's top-level `object` value tells us which product sent the webhook. */
const OBJECT_TO_CHANNEL: Record<string, ChannelKind> = {
  page: 'messenger',
  instagram: 'instagram',
};

const attachmentSchema = z.object({
  type: z.string(),
  payload: z
    .object({
      url: z.string().optional(),
      // Stickers/templates carry other shapes; unknown keys are ignored
      // rather than rejected.
    })
    .passthrough()
    .optional(),
});

const messagingEntrySchema = z.object({
  sender: z.object({ id: z.string() }).optional(),
  recipient: z.object({ id: z.string() }).optional(),
  // Meta sends unix MILLIseconds here (unlike WhatsApp's seconds-as-string).
  timestamp: z.number().optional(),
  message: z
    .object({
      mid: z.string(),
      text: z.string().optional(),
      attachments: z.array(attachmentSchema).optional(),
      /**
       * True when the "message" is one WE sent, echoed back. Meta delivers
       * these on the same subscription, and treating one as inbound would
       * make the agent answer itself — an infinite loop billed per turn.
       */
      is_echo: z.boolean().optional(),
      is_deleted: z.boolean().optional(),
      /** Set on a message the user sent by tapping a quick reply. Text is still populated. */
      quick_reply: z.object({ payload: z.string() }).passthrough().optional(),
    })
    .optional(),
  /** Read receipts: `{ watermark }`. No per-message id, which is why they are not mapped to status updates — see parseMetaSocialStatusUpdates. */
  read: z.object({ watermark: z.number().optional() }).optional(),
  delivery: z
    .object({
      mids: z.array(z.string()).optional(),
      watermark: z.number().optional(),
    })
    .optional(),
  /** Send failures Meta reports asynchronously. */
  message_edit: z.unknown().optional(),
});

const envelopeSchema = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      id: z.string(),
      time: z.number().optional(),
      messaging: z.array(messagingEntrySchema).optional(),
      /** Instagram historically used `standby` for handover-protocol traffic. Ignored — we are not a secondary receiver. */
      standby: z.array(messagingEntrySchema).optional(),
      /**
       * Gulf T8 (D6): field-change notifications — page `feed` and Instagram
       * `comments`. The value is parsed per change (leniently, see
       * parseMetaSocialComments), never here: one odd change must not reject
       * a delivery that also carries customer DMs.
       */
      changes: z
        .array(z.object({ field: z.string(), value: z.unknown() }))
        .optional(),
    }),
  ),
});

/**
 * Gulf T8 (D6): a comment on a Facebook page post or an Instagram post/Reel,
 * normalized. `channel` names the connected account it arrived on (the page
 * row is 'messenger', the IG account row is 'instagram'), so tenant
 * resolution and the page token come from the same `social_channels` row a
 * DM would use.
 */
export interface NormalizedCommentEvent {
  channel: ChannelKind;
  /** `entry[].id`: the page id or the IG professional account id. */
  channelAccountId: string;
  commentId: string;
  /** Facebook `post_id`, or the Instagram media id. */
  postId: string;
  parentId: string | null;
  /** Facebook user id, or the commenter's IGSID. Compared with channelAccountId to drop our own comments. */
  authorId: string;
  authorName: string | null;
  text: string;
  /** Facebook's `verb` (add / edited / remove / ...). Instagram sends none and only notifies on creation, so it is `add`. Only `add` triggers (D6). */
  verb: string;
  /** Instagram `media.media_product_type` (FEED, REELS, AD, ...). Null on Facebook. */
  mediaProductType: string | null;
  createdAt: Date;
}

/** Page `feed` change value. Documented fields: from, post_id, comment_id, parent_id, message, created_time, item, verb. */
const feedCommentSchema = z.object({
  item: z.literal('comment'),
  verb: z.string(),
  comment_id: z.string().min(1),
  post_id: z.string().min(1),
  parent_id: z.string().optional(),
  from: z.object({ id: z.string().min(1), name: z.string().optional() }),
  message: z.string().optional(),
  // Unix seconds on the feed field.
  created_time: z.number().optional(),
});

/**
 * Instagram `comments` change value. The Facebook Login form carries
 * `comment_id` (and `parent_id`); the Business Login form carries `id`.
 * Both are accepted so a login-mode switch does not silently stop comments.
 */
const instagramCommentSchema = z
  .object({
    comment_id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
    parent_id: z.string().optional(),
    from: z.object({ id: z.string().min(1), username: z.string().optional() }),
    text: z.string().optional(),
    media: z.object({
      id: z.string().min(1),
      media_product_type: z.string().optional(),
    }),
  })
  .refine((value) => Boolean(value.comment_id ?? value.id));

/**
 * Attachment type -> the port's fixed, provider-agnostic classification.
 *
 * Deliberately identical in spirit to the WhatsApp parser's mapping so an
 * image escalates for the same reason on every channel. `audio` maps to
 * 'voice' because that is what an audio attachment in a DM is in practice —
 * and because the port's vocabulary is the one T3's escalation matrix and
 * Feature 17's transcription path are written against.
 */
function classify(attachmentType: string): InboundMessageType {
  switch (attachmentType) {
    case 'image':
      return 'image';
    case 'audio':
      return 'voice';
    case 'file':
      return 'document';
    default:
      // video, template, fallback, share, story_mention, reel, ...
      return 'unsupported';
  }
}

type SocialEnvelope = z.infer<typeof envelopeSchema>;

/**
 * The strict envelope read shared by the DM and comment branches. Throws on a
 * malformed body; returns a null channel for a Meta product we do not serve
 * (e.g. `whatsapp_business_account`, which has its own endpoint). That is
 * zero events, not an error: Meta fans a single app's subscriptions out
 * across products, and throwing would make it retry a delivery we correctly
 * have nothing to do with.
 */
function parseStrictEnvelope(rawBody: string | Buffer): {
  channel: ChannelKind | null;
  entries: SocialEnvelope['entry'];
} {
  const parsed = envelopeSchema.safeParse(toJson(rawBody));
  if (!parsed.success) {
    throw new Error(
      `MetaChannelAdapter: unrecognized webhook envelope — ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
    );
  }
  return {
    channel: OBJECT_TO_CHANNEL[parsed.data.object] ?? null,
    entries: parsed.data.entry,
  };
}

export function parseMetaSocialEnvelope(
  rawBody: string | Buffer,
): NormalizedInboundMessage[] {
  const { channel, entries } = parseStrictEnvelope(rawBody);
  if (!channel) return [];

  const messages: NormalizedInboundMessage[] = [];

  for (const entry of entries) {
    for (const event of entry.messaging ?? []) {
      const message = event.message;
      if (!message) continue;
      // Our own message, echoed back. Dropped before anything else touches
      // it — see is_echo's comment above.
      if (message.is_echo) continue;
      if (message.is_deleted) continue;
      if (!event.sender?.id) continue;

      const attachment = message.attachments?.[0];
      const type: InboundMessageType = attachment
        ? classify(attachment.type)
        : 'text';

      const media: InboundMediaDescriptor | undefined = attachment
        ? {
            // Gulf T6 (D9): Messenger/IG hand out a signed CDN url, not a
            // media id, and the port names it for what it is. Fetched only
            // from the host allowlist (SocialMediaFetcher); an empty or
            // off-allowlist url is refused there and escalated to a human.
            mediaUrl: attachment.payload?.url ?? '',
            mimeType: null,
            filename: null,
            caption: message.text ?? null,
          }
        : undefined;

      messages.push({
        channel,
        channelAccountId: entry.id,
        providerMessageId: message.mid,
        from: event.sender.id,
        type,
        ...(type === 'text' ? { text: message.text ?? '' } : {}),
        ...(media ? { media } : {}),
        receivedAt: event.timestamp ? new Date(event.timestamp) : new Date(),
      });
    }
  }

  return messages;
}

/**
 * Delivery receipts, normalized.
 *
 * Only `delivery.mids` is mapped. Meta's `read` event carries a WATERMARK
 * (a timestamp meaning "everything up to here has been read") and no message
 * id at all, so there is nothing to match a stored message on — reporting it
 * would mean guessing which rows it covers. Dropping it is honest; the
 * conversation simply shows 'delivered' rather than a fabricated 'read'.
 */
export function parseMetaSocialStatusUpdates(
  rawBody: string | Buffer,
): NormalizedStatusUpdate[] {
  // Reports nothing rather than throwing, on a malformed body as well as a
  // schema mismatch. This runs on EVERY webhook, including ones carrying real
  // customer messages, so a throw here would reject deliveries over a status
  // field we do not even need. `parseInboundWebhook` is the strict path and
  // still rejects the same body loudly.
  let json: unknown;
  try {
    json = toJson(rawBody);
  } catch {
    return [];
  }

  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) return [];

  const channel = OBJECT_TO_CHANNEL[parsed.data.object];
  if (!channel) return [];

  const updates: NormalizedStatusUpdate[] = [];
  for (const entry of parsed.data.entry) {
    for (const event of entry.messaging ?? []) {
      for (const mid of event.delivery?.mids ?? []) {
        updates.push({
          channel,
          channelAccountId: entry.id,
          providerMessageId: mid,
          status: 'delivered',
          error: null,
          occurredAt: event.timestamp ? new Date(event.timestamp) : new Date(),
        });
      }
    }
  }
  return updates;
}

/**
 * Gulf T8 (D6): comments on page posts (`feed`, item `comment`) and on
 * Instagram posts/Reels (`comments`), from `entry[].changes[]`.
 *
 * Strict at the envelope like parseMetaSocialEnvelope (it is the same body),
 * lenient per change: a change that is not a comment, or a comment missing
 * its id or author, is skipped rather than rejecting the delivery. Every
 * verb is returned; the caller drops anything but `add`, so the decision is
 * visible where it is made.
 */
export function parseMetaSocialComments(
  rawBody: string | Buffer,
): NormalizedCommentEvent[] {
  const { channel, entries } = parseStrictEnvelope(rawBody);
  if (!channel) return [];

  return entries.flatMap((entry) =>
    (entry.changes ?? []).flatMap((change) => {
      const entryTime = entry.time ? new Date(entry.time * 1000) : new Date();
      const comment =
        channel === 'instagram'
          ? toInstagramComment(entry.id, change, entryTime)
          : toFeedComment(entry.id, change, entryTime);
      return comment ? [comment] : [];
    }),
  );
}

function toFeedComment(
  channelAccountId: string,
  change: { field: string; value?: unknown },
  entryTime: Date,
): NormalizedCommentEvent | null {
  if (change.field !== 'feed') return null;
  const parsed = feedCommentSchema.safeParse(change.value);
  if (!parsed.success) return null;
  const value = parsed.data;
  return {
    channel: 'messenger',
    channelAccountId,
    commentId: value.comment_id,
    postId: value.post_id,
    parentId: value.parent_id ?? null,
    authorId: value.from.id,
    authorName: value.from.name ?? null,
    text: value.message ?? '',
    verb: value.verb,
    mediaProductType: null,
    createdAt: value.created_time
      ? new Date(value.created_time * 1000)
      : entryTime,
  };
}

function toInstagramComment(
  channelAccountId: string,
  change: { field: string; value?: unknown },
  entryTime: Date,
): NormalizedCommentEvent | null {
  if (change.field !== 'comments') return null;
  const parsed = instagramCommentSchema.safeParse(change.value);
  if (!parsed.success) return null;
  const value = parsed.data;
  return {
    channel: 'instagram',
    channelAccountId,
    commentId: (value.comment_id ?? value.id) as string,
    postId: value.media.id,
    parentId: value.parent_id ?? null,
    authorId: value.from.id,
    authorName: value.from.username ?? null,
    text: value.text ?? '',
    // Instagram notifies on creation only and carries no verb.
    verb: 'add',
    mediaProductType: value.media.media_product_type ?? null,
    createdAt: entryTime,
  };
}

function toJson(rawBody: string | Buffer): unknown {
  try {
    return JSON.parse(
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
    );
  } catch {
    throw new Error('MetaChannelAdapter: webhook body is not valid JSON.');
  }
}
