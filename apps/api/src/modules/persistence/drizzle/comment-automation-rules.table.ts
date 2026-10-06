// Gulf T8 (F23): a tenant's comment-automation rules. Two tables:
//   - `comment_automation_settings`: one row per tenant — on/off, which
//     intents get an answer, keyword triggers, spam keywords, the public reply
//     template, and the hourly caps (D11).
//   - `comment_post_rules`: per-post overrides — enable/disable one post (or,
//     with post scope `selected`, the allow-list) and an optional per-post
//     public reply template.
// No row means the defaults below, which have automation OFF: a tenant opts in
// before anything is posted publicly under their brand.
import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import type { ChannelKind } from '../../channel/ports/channel-kind';

/** Intents the full agent may answer (D11). Other intents never reach it. */
export const COMMENT_REPLY_INTENTS = ['purchase', 'question'] as const;
export type CommentReplyIntent = (typeof COMMENT_REPLY_INTENTS)[number];

/** `all`: every post except those disabled per post. `selected`: only posts enabled per post. */
export const COMMENT_POST_SCOPES = ['all', 'selected'] as const;
export type CommentPostScope = (typeof COMMENT_POST_SCOPES)[number];

export const commentAutomationSettings = pgTable(
  'comment_automation_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    postScope: text('post_scope')
      .notNull()
      .default('all')
      .$type<CommentPostScope>(),
    replyIntents: jsonb('reply_intents')
      .notNull()
      .default(['purchase', 'question'])
      .$type<CommentReplyIntent[]>(),
    /** A comment containing one of these is answered without the classifier (e.g. "price", "بكم"). */
    keywordTriggers: jsonb('keyword_triggers')
      .notNull()
      .default([])
      .$type<string[]>(),
    /** A comment containing one of these is treated as spam: hidden (when `hide_spam`), never answered. */
    spamKeywords: jsonb('spam_keywords')
      .notNull()
      .default([])
      .$type<string[]>(),
    hideSpam: boolean('hide_spam').notNull().default(true),
    publicReplyTemplate: text('public_reply_template').notNull(),
    hourlyReplyCapPerPost: integer('hourly_reply_cap_per_post')
      .notNull()
      .default(30),
    hourlyReplyCapPerTenant: integer('hourly_reply_cap_per_tenant')
      .notNull()
      .default(200),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('comment_automation_settings_tenant_id_unique').on(table.tenantId),
  ],
).enableRLS();

export const commentPostRules = pgTable(
  'comment_post_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** 'messenger' (Facebook page) or 'instagram' — the connected account the post belongs to. */
    channel: text('channel').notNull().$type<ChannelKind>(),
    channelAccountId: text('channel_account_id').notNull(),
    /** Facebook post id or Instagram media id, exactly as the webhook names it. */
    postId: text('post_id').notNull(),
    enabled: boolean('enabled').notNull(),
    /** Overrides the tenant template for this post. Null = use the tenant's. */
    publicReplyTemplate: text('public_reply_template'),
    updatedBy: uuid('updated_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('comment_post_rules_tenant_post_unique').on(
      table.tenantId,
      table.channelAccountId,
      table.postId,
    ),
    index('comment_post_rules_tenant_idx').on(table.tenantId),
  ],
).enableRLS();
