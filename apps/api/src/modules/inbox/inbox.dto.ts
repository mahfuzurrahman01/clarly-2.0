// Product shell (InboxModule): request/response contract for the
// conversation inbox. Zod via nestjs-zod, matching kanban.dto.ts — one
// validation library across the codebase, and the OpenAPI schema the
// console generates its types from comes free.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { CHANNELS } from '../channel/ports/channel-kind';
import { OUT_OF_WINDOW_OPTIONS } from '../channel/ports/channel-policy.port';
import {
  FEEDBACK_RATINGS,
  HANDOVER_STATES,
  MEDIA_STATUSES,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_ROLES,
} from '../persistence/drizzle/schema';
import { isoTimestamp } from '../../common/iso-timestamp';

/** Page size ceiling. The list carries a message preview per row, so an unbounded `limit` is an unbounded response — clamped rather than trusted. */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const cursorSchema = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Opaque cursor from the previous page's `nextCursor`. Omit for the first page. Not a page number — do not construct one by hand.",
  );

const limitSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(MAX_PAGE_SIZE)
  .default(DEFAULT_PAGE_SIZE)
  .describe(`Rows per page, 1-${MAX_PAGE_SIZE}.`);

export const listConversationsQuerySchema = z
  .object({
    limit: limitSchema,
    cursor: cursorSchema,
    phone: z
      .string()
      .min(1)
      .optional()
      .describe('Substring match against the customer phone number.'),
    from: z.coerce
      .date()
      .optional()
      .describe(
        'Only conversations whose last inbound message is at or after this instant.',
      ),
    to: z.coerce
      .date()
      .optional()
      .describe(
        'Only conversations whose last inbound message is at or before this instant.',
      ),
    escalated: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional()
      .describe(
        'true = only conversations that produced a ticket, false = only those that never did. Omit for both.',
      ),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: '`from` must not be after `to`.',
    path: ['from'],
  });

export type ListConversationsQuery = z.infer<
  typeof listConversationsQuerySchema
>;

export class ListConversationsQueryDto extends createZodDto(
  listConversationsQuerySchema,
) {}

export const listMessagesQuerySchema = z.object({
  limit: limitSchema,
  cursor: cursorSchema,
});

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;

export class ListMessagesQueryDto extends createZodDto(
  listMessagesQuerySchema,
) {}

export const rateAnswerBodySchema = z.object({
  rating: z.enum(FEEDBACK_RATINGS),
  note: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .describe(
      'Why. The single most useful field for turning this into an eval case later, and the one a thumbs-down alone cannot give.',
    ),
});

export type RateAnswerBody = z.infer<typeof rateAnswerBodySchema>;
export class RateAnswerBodyDto extends createZodDto(rateAnswerBodySchema) {}

export const sendReplyBodySchema = z.object({
  text: z.string().trim().min(1).max(4096),
  /**
   * Client-generated id (a uuid), unique per tenant. Sending the same id
   * twice returns the first result instead of putting the message in front of
   * the customer twice — a support agent double-clicking send is not a
   * hypothetical, and the console cannot prevent it on its own.
   */
  clientMessageId: z.string().uuid(),
});

export type SendReplyBody = z.infer<typeof sendReplyBodySchema>;
export class SendReplyBodyDto extends createZodDto(sendReplyBodySchema) {}

export const sendReplyResultSchema = z.object({
  messageId: z.string().uuid(),
  delivered: z
    .boolean()
    .describe(
      'False when the BSP rejected the send. The reply is stored either way and appears in the transcript marked as not delivered — losing the text the agent typed would be worse than showing a failure.',
    ),
  deliveryError: z.string().nullable(),
});

export class SendReplyResultDto extends createZodDto(sendReplyResultSchema) {}

export const sendTemplateBodySchema = z.object({
  templateId: z
    .string()
    .uuid()
    .describe(
      'An **approved** `whatsapp_template` from `GET /templates`. A canned reply is rejected — those only send inside the window.',
    ),
  values: z
    .array(z.string().max(1000))
    .max(20)
    .default([])
    .describe(
      'One value per `{{n}}` placeholder, in position order. A count that does not match the template is rejected rather than blank-filled — "your order  shipped" reads as a bug to the customer and is invisible to the sender.',
    ),
  /** Same idempotency contract as a free-form reply, and it matters more here: a template send costs the tenant money per message. */
  clientMessageId: z.string().uuid(),
});

export type SendTemplateBody = z.infer<typeof sendTemplateBodySchema>;
export class SendTemplateBodyDto extends createZodDto(sendTemplateBodySchema) {}

export const sendTemplateResultSchema = sendReplyResultSchema.extend({
  text: z
    .string()
    .describe(
      'The filled-in body, exactly as the customer reads it. Stored in the transcript in this form — a `{{1}}` in the history tells the next person nothing.',
    ),
});

export class SendTemplateResultDto extends createZodDto(
  sendTemplateResultSchema,
) {}

const lastMessageSchema = z.object({
  role: z.enum(MESSAGE_ROLES),
  content: z.string(),
  createdAt: isoTimestamp(),
});

const channelSchema = z
  .enum(CHANNELS)
  .describe(
    'Which channel this thread arrived on. The inbox is unified — all three appear in one list — so this is a badge/filter value, not a separate view.',
  );

export const conversationSummarySchema = z.object({
  id: z.string().uuid(),
  channel: channelSchema,
  customerPhone: z
    .string()
    .describe(
      "The customer's channel-scoped identity. NOT always a phone number: a PSID on Messenger, an IGSID on Instagram. Label it by channel rather than as 'phone'.",
    ),
  customerName: z.string().nullable(),
  lastInboundAt: isoTimestamp(),
  lastMessage: lastMessageSchema
    .nullable()
    .describe(
      'Newest message of the conversation, or null once its transcript has been purged (T16) while the conversation row survives.',
    ),
  messageCount: z.number().int(),
  escalated: z.boolean(),
  label: z
    .string()
    .nullable()
    .describe(
      "The customer's label as stored, never pre-formatted: 'hot' | 'warm' | 'cold' when the agent derived it, any tenant-chosen string when a person overrode it, null when there is none yet. Localise the three agent values; show an override as-is.",
    ),
});

const replyWindowSchema = z
  .object({
    open: z
      .boolean()
      .describe(
        'Whether this channel still accepts a free-form reply from a human agent. Once false, only the options in `outOfWindowOptions` will send — a plain reply is rejected by the provider.',
      ),
    expiresAt: isoTimestamp().describe(
      'When the window shuts. 24 hours after the last inbound message on WhatsApp; up to 7 days on Messenger/Instagram, because this is evaluated for a HUMAN agent and Meta extends the window for one. Already past when `open` is false.',
    ),
    outOfWindowOptions: z
      .array(z.enum(OUT_OF_WINDOW_OPTIONS))
      .describe(
        "What is still possible once `open` is false. 'template' (WhatsApp only) means POST /conversations/:id/template-messages; 'message_tag'/'human_agent' are Meta tags the send path applies itself. An empty array means nothing will send.",
      ),
  })
  .describe(
    "The channel's messaging window, evaluated at read time for a human agent.",
  );

export const conversationDetailSchema = z.object({
  id: z.string().uuid(),
  channel: channelSchema,
  customerPhone: z.string(),
  customerName: z.string().nullable(),
  lastInboundAt: isoTimestamp(),
  rollingSummary: z.string().nullable(),
  messageCount: z.number().int(),
  escalated: z.boolean(),
  createdAt: isoTimestamp(),
  handoverState: z
    .enum(HANDOVER_STATES)
    .describe(
      "'human' means a person has taken the conversation over and the agent will not answer inbound messages until it is handed back.",
    ),
  handoverAt: isoTimestamp().nullable(),
  handoverUserId: z.string().uuid().nullable(),
  replyWindow: replyWindowSchema,
  intake: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        value: z.string(),
        scope: z.string(),
      }),
    )
    .describe(
      "What the agent collected from this customer, labelled with the tenant's own wording. Shown so a human taking over never re-asks what the customer already answered.",
    ),
});

export const conversationMessageSchema = z.object({
  id: z.string().uuid(),
  role: z
    .enum(MESSAGE_ROLES)
    .describe(
      "'user' is the customer, 'assistant' is the AI agent, 'human_agent' is a person on the team.",
    ),
  content: z.string(),
  createdAt: isoTimestamp(),
  deliveryStatus: z
    .enum(MESSAGE_DELIVERY_STATUSES)
    .nullable()
    .describe(
      "Outbound only, from the BSP's status callbacks. Null on inbound rows and on outbound rows not yet reported on.",
    ),
  deliveryError: z.string().nullable(),
  authorUserId: z.string().uuid().nullable(),
  feedback: z
    .object({
      rating: z.enum(FEEDBACK_RATINGS),
      note: z.string().nullable(),
    })
    .nullable()
    .describe("A human's verdict on this reply, when someone has given one."),
  media: z
    .object({
      status: z
        .enum(MEDIA_STATUSES)
        .describe(
          "'stored' is the only one with bytes to fetch. 'pending' means they are still being retrieved; 'failed' and 'too_large' mean they are not coming and `error` says why — render the difference, because only one of them is worth waiting on.",
        ),
      mimeType: z
        .string()
        .nullable()
        .describe(
          "The BSP's content type. Advisory only — it is attacker-influenced, so do not use it to decide whether something is safe to render inline.",
        ),
      sizeBytes: z.number().int().nullable(),
      filename: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable()
    .describe(
      'The attachment the customer sent. Bytes are fetched separately from `GET /conversations/:id/messages/:messageId/media`; inlining them would make a transcript page megabytes.',
    ),
});

/** `nextCursor` is null on the last page. Stop on null, never on a short page — a filtered page can be short and still have more behind it. */
const pageOf = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const conversationPageSchema = pageOf(conversationSummarySchema);
export const messagePageSchema = pageOf(conversationMessageSchema);

export class ConversationDetailDto extends createZodDto(
  conversationDetailSchema,
) {}
export class ConversationPageDto extends createZodDto(conversationPageSchema) {}
export class MessagePageDto extends createZodDto(messagePageSchema) {}
