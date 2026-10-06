// F26 (Delivery Tracking): the shipment status history.
//
// The (shipment_id, raw_status, occurred_at) unique key is load-bearing, not
// hygiene: polling re-reads the courier's WHOLE event list on every sweep, so
// without it the history would grow by the full list every ten minutes (D3).
// `raw_status` is part of the key rather than `status`, because two different
// courier codes can normalize to the same platform status and both are real
// events.
//
// `raw_status` and `location` are courier-controlled strings. They are stored
// and shown in the console, but `raw_status` NEVER reaches the model (D4) and
// `location` only does through a whitelist sanitizer.
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

export const shipmentStatusEvents = pgTable(
  'shipment_status_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    /** The courier's own status code. Support/debugging only — never in a tool payload. */
    rawStatus: text('raw_status').notNull(),
    location: text('location'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    source: text('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.shipmentId, table.rawStatus, table.occurredAt),
    index('shipment_status_events_shipment_idx').on(
      table.tenantId,
      table.shipmentId,
      table.occurredAt,
    ),
  ],
).enableRLS();
