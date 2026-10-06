// Clarly 2.0 S4 (migration 0074): channel pauses, 24-hour-window broadcasts
// and automatic follow-ups. All FORCE RLS — read and write them only through
// `withTenantTx`.
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { ChannelKind } from '../../channel/ports/channel-kind';
import { conversations } from './conversations.table';
import { tenants } from './tenants.table';

/** A row means: the agent does not reply on this channel account. Inbound is still stored for the team. */
export const channelPauses = pgTable(
  'channel_pauses',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull().$type<ChannelKind>(),
    channelAccountId: text('channel_account_id').notNull(),
    pausedAt: timestamp('paused_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    pausedBy: uuid('paused_by'),
  },
  (table) => [
    primaryKey({
      name: 'channel_pauses_pkey',
      columns: [table.tenantId, table.channel, table.channelAccountId],
    }),
  ],
).enableRLS();

export const BROADCAST_STATUSES = [
  'sending',
  'completed',
  'canceled',
  'failed',
] as const;
export type BroadcastStatus = (typeof BROADCAST_STATUSES)[number];

export const BROADCAST_RECIPIENT_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
  'skipped',
] as const;
export type BroadcastRecipientStatus =
  (typeof BROADCAST_RECIPIENT_STATUSES)[number];

export const broadcasts = pgTable(
  'broadcasts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    message: text('message').notNull(),
    /** Channel filter; empty = every broadcastable channel. */
    channels: text('channels')
      .array()
      .notNull()
      .default([])
      .$type<ChannelKind[]>(),
    /** The segment filter as it was when the broadcast was sent (null = everyone in the window). */
    segmentDefinition: jsonb('segment_definition'),
    status: text('status')
      .notNull()
      .default('sending')
      .$type<BroadcastStatus>(),
    total: integer('total').notNull().default(0),
    sent: integer('sent').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    unique('broadcasts_tenant_id_id_unique').on(table.tenantId, table.id),
    uniqueIndex('broadcasts_one_sending_per_tenant')
      .on(table.tenantId)
      .where(sql`"status" = 'sending'`),
    index('broadcasts_tenant_created_idx').on(
      table.tenantId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
  ],
).enableRLS();

export const broadcastRecipients = pgTable(
  'broadcast_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    broadcastId: uuid('broadcast_id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull().$type<ChannelKind>(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<BroadcastRecipientStatus>(),
    skipReason: text('skip_reason'),
    /** The platform's own words when a send failed — the owner acts on them. */
    error: text('error'),
    messageId: uuid('message_id'),
    attemptCount: integer('attempt_count').notNull().default(0),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('broadcast_recipients_unique').on(
      table.broadcastId,
      table.conversationId,
    ),
    index('broadcast_recipients_queue_idx').on(
      table.broadcastId,
      table.status,
      table.id,
    ),
  ],
).enableRLS();

export const FOLLOWUP_AUDIENCES = ['interested', 'all'] as const;
export type FollowupAudience = (typeof FOLLOWUP_AUDIENCES)[number];

export const followupSettings = pgTable('followup_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  /** Hours of quiet before the nudge; ≤22 so it always lands inside the 24 h window. */
  delayHours: integer('delay_hours').notNull().default(20),
  message: text('message').notNull(),
  audience: text('audience')
    .notNull()
    .default('interested')
    .$type<FollowupAudience>(),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();

export const FOLLOWUP_STATUSES = ['sent', 'failed', 'skipped'] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

export const followups = pgTable(
  'followups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    /** The customer's last message the nudge answers — one follow-up per anchor, ever. */
    anchorInboundAt: timestamp('anchor_inbound_at', {
      withTimezone: true,
    }).notNull(),
    status: text('status').notNull().$type<FollowupStatus>(),
    skipReason: text('skip_reason'),
    error: text('error'),
    messageId: uuid('message_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('followups_once_per_anchor').on(
      table.tenantId,
      table.conversationId,
      table.anchorInboundAt,
    ),
    index('followups_conversation_recent_idx').on(
      table.tenantId,
      table.conversationId,
      table.createdAt.desc(),
    ),
    index('followups_tenant_created_idx').on(
      table.tenantId,
      table.createdAt.desc(),
    ),
  ],
).enableRLS();
