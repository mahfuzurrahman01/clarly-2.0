// F26 (Delivery Tracking): one row per tracked parcel.
//
// `customer_id` is denormalized from the order at creation deliberately (D3):
// it IS the `track_order` authorization predicate (D4), so the check is a
// single-table `tenant_id = ctx.tenantId AND customer_id = ctx.customerId`
// that no LLM-supplied argument can widen — never a join through `orders`
// whose shape another feature owns.
//
// `order_id`'s foreign key to `orders` is declared in migration 0060's SQL
// rather than here: `orders` is F25's table and F26 references it without
// owning it, so this file does not import F25's table module. The database is
// the barrier that matters for referential integrity; `.references()` only
// affects drizzle-kit's generated DDL, which this repo hand-writes.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.table';
import { customers } from './customers.table';
import { courierConnections } from './courier-connections.table';

/**
 * The platform's normalized status vocabulary. Courier status strings are
 * mapped INTO this; nothing downstream ever reads a courier's own status
 * text (D2/D4). Kept in lockstep with migration 0060's CHECK constraint.
 */
export const SHIPMENT_STATUSES = [
  'label_created',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'failed_attempt',
  'returned',
  'cancelled',
  'exception',
  'unknown',
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** Statuses that are never polled again — enforced by the partial index below, not by a code filter that can drift. */
export const TERMINAL_SHIPMENT_STATUSES = [
  'delivered',
  'returned',
  'cancelled',
] as const;

export const SHIPMENT_EVENT_SOURCES = ['poll', 'webhook', 'manual'] as const;
export type ShipmentEventSource = (typeof SHIPMENT_EVENT_SOURCES)[number];

export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** F25 owns `orders`; F26 only references it. FK lives in 0060's SQL — see the header. */
    orderId: uuid('order_id').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    courierConnectionId: uuid('courier_connection_id')
      .notNull()
      .references(() => courierConnections.id, { onDelete: 'restrict' }),
    courier: text('courier').notNull(),
    trackingNumber: text('tracking_number').notNull(),
    currentStatus: text('current_status').notNull().default('label_created'),
    currentStatusAt: timestamp('current_status_at', { withTimezone: true }),
    estimatedDeliveryAt: timestamp('estimated_delivery_at', {
      withTimezone: true,
    }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /** Console read convenience. `shipment_notifications` is the dedup authority (D5). */
    lastNotifiedStatus: text('last_notified_status'),
    lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    pollFailureCount: integer('poll_failure_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.tenantId, table.courier, table.trackingNumber),
    index('shipments_order_idx').on(table.tenantId, table.orderId),
    index('shipments_customer_idx').on(table.tenantId, table.customerId),
    // The poll sweep's only query. Partial, so terminal shipments cost
    // nothing and can never be selected for polling however the code drifts.
    index('shipments_poll_idx')
      .on(table.lastPolledAt)
      .where(
        sql`"current_status" NOT IN ('delivered', 'returned', 'cancelled')`,
      ),
    index('shipments_connection_idx').on(table.courierConnectionId),
  ],
).enableRLS();
