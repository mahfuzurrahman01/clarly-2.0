// F26 (Delivery Tracking): per-tenant opt-in for proactive shipment updates
// (D5).
//
// `enabled` defaults to FALSE and is an opt-IN, not an opt-out: these are
// billed, business-initiated WhatsApp messages, so a tenant who has never
// configured this must never send one.
//
// `status_templates` maps a `ShipmentStatus` to a `message_templates.id`. A
// status with no mapping is never notified, which makes the notifiable set
// the tenant's own choice rather than a platform constant.
//
// `tenant_id` is the primary key, like `tenant_policy` — one settings row per
// tenant, and RLS keys off the same column.
import { pgTable, uuid, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

export const deliveryNotificationSettings = pgTable(
  'delivery_notification_settings',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    statusTemplates: jsonb('status_templates')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
).enableRLS();
