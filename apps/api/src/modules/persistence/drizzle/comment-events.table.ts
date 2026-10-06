// Gulf T8 (F23, D6/D15b): the comment ledger. One row per comment we accepted
// for automation — a comment on a Facebook page post, or on an Instagram post
// or Reel, from someone other than the page/IG account itself, with verb `add`.
//
// `unique(channel, comment_id)` is the replay guard: Meta redelivers webhooks,
// and the insert that loses the race is how a replay is recognised. Nothing
// downstream (classify, agent, Graph calls) runs for a comment that did not
// win this insert.
//
// RLS-scoped like every tenant table: rows are written after tenant resolution
// (the `social_channels` lookup), inside `withTenantTx`.
//
// The row is also the D15b private-reply thread. After a private reply is sent
// it records who it went to (`private_reply_recipient_id`, the PSID/IGSID Meta
// answered with) and sits in `thread_state = 'awaiting_reply'`. Nothing is
// opened in the inbox until that person writes back; their first DM adopts the
// row (`replied`, `conversation_id`) and the conversation continues on the
// normal respond path.
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { conversations } from './conversations.table';
import type { ChannelKind } from '../../channel/ports/channel-kind';

/**
 * received  — ledger row written, job queued, nothing decided yet.
 * planned   — the decision and any reply texts are stored; actions are being
 *             executed (a job resumed after a deferral starts here, so the
 *             classifier and the agent never run twice for one comment).
 * completed — every planned action reached a final state.
 * skipped   — nothing will be done (see `skip_reason`).
 */
export const COMMENT_EVENT_STATUSES = [
  'received',
  'planned',
  'completed',
  'skipped',
] as const;
export type CommentEventStatus = (typeof COMMENT_EVENT_STATUSES)[number];

/** What the tiered filter decided (D11). */
export const COMMENT_DECISIONS = ['reply', 'hide', 'none'] as const;
export type CommentDecision = (typeof COMMENT_DECISIONS)[number];

/** D15b: the private-reply thread. Null until a private reply is sent. */
export const COMMENT_THREAD_STATES = ['awaiting_reply', 'replied'] as const;
export type CommentThreadState = (typeof COMMENT_THREAD_STATES)[number];

export const commentEvents = pgTable(
  'comment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** 'messenger' (a Facebook page's comments) or 'instagram'. The `social_channels` row it arrived on. */
    channel: text('channel').notNull().$type<ChannelKind>(),
    channelAccountId: text('channel_account_id').notNull(),
    commentId: text('comment_id').notNull(),
    postId: text('post_id').notNull(),
    parentId: text('parent_id'),
    /** Facebook user id or IGSID of the commenter. */
    authorId: text('author_id').notNull(),
    authorName: text('author_name'),
    text: text('text').notNull(),
    mediaProductType: text('media_product_type'),
    /** When the commenter posted it. The 7-day private-reply window runs from here. */
    commentCreatedAt: timestamp('comment_created_at', {
      withTimezone: true,
    }).notNull(),
    status: text('status')
      .notNull()
      .default('received')
      .$type<CommentEventStatus>(),
    skipReason: text('skip_reason'),
    /** The classified intent (purchase, question, complaint, spam, abuse, other) or the rule that decided. */
    intent: text('intent'),
    decision: text('decision').$type<CommentDecision>(),
    publicReplyText: text('public_reply_text'),
    privateReplyText: text('private_reply_text'),
    privateReplyRecipientId: text('private_reply_recipient_id'),
    privateReplyMessageId: text('private_reply_message_id'),
    privateReplySentAt: timestamp('private_reply_sent_at', {
      withTimezone: true,
    }),
    threadState: text('thread_state').$type<CommentThreadState>(),
    /** Set when the commenter answered the private reply and a conversation was opened. */
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('comment_events_channel_comment_id_unique').on(
      table.channel,
      table.commentId,
    ),
    index('comment_events_tenant_created_idx').on(
      table.tenantId,
      table.createdAt,
    ),
    // D15b: "does this DM sender have a private reply waiting on them".
    index('comment_events_awaiting_reply_idx')
      .on(table.tenantId, table.channelAccountId, table.privateReplyRecipientId)
      .where(sql`${table.threadState} = 'awaiting_reply'`),
  ],
).enableRLS();
