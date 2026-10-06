// Gulf T8 (F23, D6): one row per (comment, action) we attempt on Meta — a
// public reply, a private reply, or a hide.
//
// `unique(comment_id, action)` is claimed BEFORE the Graph call. A second
// worker, a job retry or a webhook replay that reaches the same action finds
// the row and does not call Meta again, which is what makes "exactly one
// public + one private reply, still one on replay" hold even if the process
// dies between Meta answering and us recording it.
//
// That makes the guarantee at-most-once. A claim is only ever re-opened when
// we KNOW Meta did not perform the call: our own limiter deferred it before
// calling, or Meta answered with a throttling error (status `released`). A
// timeout or 5xx leaves the row `failed`: Meta may have done it, and a second
// private reply is worse than none (Meta allows one per comment anyway).
import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { commentEvents } from './comment-events.table';

export const COMMENT_ACTIONS = [
  'public_reply',
  'private_reply',
  'hide',
] as const;
export type CommentAction = (typeof COMMENT_ACTIONS)[number];

/**
 * claimed   — reserved; the Graph call is in flight (or the process died mid-call).
 * succeeded — Meta confirmed it. `provider_ref` holds the reply id / message id.
 * failed    — Meta refused, or the outcome is unknown. Never retried.
 * released  — definitely not performed (deferred by the limiter, or throttled
 *             by Meta). The only state a new claim may take over.
 */
export const COMMENT_ACTION_STATUSES = [
  'claimed',
  'succeeded',
  'failed',
  'released',
] as const;
export type CommentActionStatus = (typeof COMMENT_ACTION_STATUSES)[number];

export const commentActions = pgTable(
  'comment_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    commentEventId: uuid('comment_event_id')
      .notNull()
      .references(() => commentEvents.id, { onDelete: 'cascade' }),
    commentId: text('comment_id').notNull(),
    action: text('action').notNull().$type<CommentAction>(),
    status: text('status')
      .notNull()
      .default('claimed')
      .$type<CommentActionStatus>(),
    providerRef: text('provider_ref'),
    error: text('error'),
    attempts: integer('attempts').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('comment_actions_comment_id_action_unique').on(
      table.commentId,
      table.action,
    ),
  ],
).enableRLS();
