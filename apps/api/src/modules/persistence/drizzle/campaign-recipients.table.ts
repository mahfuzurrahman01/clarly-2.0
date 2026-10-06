// F19 (D5): the snapshot of who a campaign actually messages, and the
// terminal record of what happened to each of them. See
// docs/decisions/F19-campaigns-broadcast.md — "the campaign's numbers and
// the webhook layer's writes are the same rows" is the whole reconciliation
// story, and it depends on this table being the only place a count is kept.
import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  timestamp,
  unique,
  index,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { campaigns } from './campaigns.table';
import { customers } from './customers.table';

export const CAMPAIGN_RECIPIENT_STATUSES = [
  'pending',
  'sending',
  'sent',
  'failed',
  'skipped',
] as const;
export type CampaignRecipientStatus =
  (typeof CAMPAIGN_RECIPIENT_STATUSES)[number];

export const CAMPAIGN_RECIPIENT_SKIP_REASONS = [
  'opted_out',
  'canceled',
  'no_conversation',
  'invalid_phone',
] as const;
export type CampaignRecipientSkipReason =
  (typeof CAMPAIGN_RECIPIENT_SKIP_REASONS)[number];

export const CAMPAIGN_DELIVERY_STATUSES = [
  'sent',
  'delivered',
  'read',
  'failed',
] as const;
export type CampaignDeliveryStatus =
  (typeof CAMPAIGN_DELIVERY_STATUSES)[number];

export const campaignRecipients = pgTable(
  'campaign_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    campaignId: uuid('campaign_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    conversationId: uuid('conversation_id'),
    /** The `messages` row for this send, for the transcript link. Not an FK — same reasoning as `messages.author_user_id`: written well after this row, by a sender this session does not build yet. */
    messageId: uuid('message_id'),
    /** Snapshotted: the number we actually resolved this customer to, at snapshot time. */
    phone: text('phone').notNull(),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<CampaignRecipientStatus>(),
    skipReason: text('skip_reason').$type<CampaignRecipientSkipReason>(),
    bspMessageId: text('bsp_message_id'),
    deliveryStatus: text('delivery_status').$type<CampaignDeliveryStatus>(),
    deliveryError: text('delivery_error'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 4, mode: 'number' }),
    attemptCount: integer('attempt_count').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    readAt: timestamp('read_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The exactly-once key: SegmentResolver.snapshot()'s
    // `ON CONFLICT (campaign_id, customer_id) DO NOTHING` targets this.
    unique('campaign_recipients_campaign_id_customer_id_unique').on(
      table.campaignId,
      table.customerId,
    ),
    foreignKey({
      columns: [table.tenantId, table.campaignId],
      foreignColumns: [campaigns.tenantId, campaigns.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.tenantId, table.customerId],
      foreignColumns: [customers.tenantId, customers.id],
    }).onDelete('cascade'),
    index('campaign_recipients_campaign_status_idx').on(
      table.campaignId,
      table.status,
    ),
    index('campaign_recipients_tenant_customer_sent_idx').on(
      table.tenantId,
      table.customerId,
      table.sentAt,
    ),
  ],
).enableRLS();
