// F26 (Delivery Tracking): the "we already told them" claim log (D5).
//
// The UNIQUE (shipment_id, status) index IS the lock. A notification is
// claimed with `onConflictDoNothing` BEFORE the send; no row returned means
// somebody else already claimed that transition, so this caller stops. That
// is what makes a duplicate billed template impossible rather than unlikely
// when a poll and a webhook observe the same transition at the same instant.
//
// `shipments.last_notified_status` / `last_notified_at` are a console read
// convenience written after a successful send — they are NOT the authority.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { shipments } from './shipments.table';
import { messageTemplates } from './message-templates.table';

export const SHIPMENT_NOTIFICATION_OUTCOMES = [
  'claimed',
  'sent',
  'failed',
  'skipped_opt_out',
  'skipped_no_template',
  'skipped_disabled',
] as const;
export type ShipmentNotificationOutcome =
  (typeof SHIPMENT_NOTIFICATION_OUTCOMES)[number];

export const shipmentNotifications = pgTable(
  'shipment_notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    templateId: uuid('template_id').references(() => messageTemplates.id, {
      onDelete: 'set null',
    }),
    messageId: uuid('message_id'),
    outcome: text('outcome').notNull().default('claimed'),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.shipmentId, table.status),
    index('shipment_notifications_shipment_idx').on(
      table.tenantId,
      table.shipmentId,
    ),
    index('shipment_notifications_template_idx').on(table.templateId),
  ],
).enableRLS();
