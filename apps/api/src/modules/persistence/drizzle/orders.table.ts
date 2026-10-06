// F25 (Orders in Chat), D2: Clarly's order of record.
//
// This table is AUTHORITATIVE and is always written first; a connected store
// (F24) is a sync target, never the system of record — exactly as `products`
// is the canonical catalog with store sync writing into it (F20 D6). An
// order's relationship with the customer must not be hostage to Salla's
// uptime, which is why `store_sync_status` is a SEPARATE lifecycle from
// `status` and not a member of the status enum.
//
// What the model is trusted with (D2.2): nothing that decides a row. The
// `customer_id` and `conversation_id` come from the turn context, never from
// tool arguments. `contact_*`/`city`/`address`/`notes` are display/delivery
// data the agent collected conversationally — length-capped by Zod, stored as
// given (Gulf addresses are informal), and never used for authorization or row
// lookup. Prices and names are re-read from `products` inside the write
// transaction and snapshotted, never taken from tool args.
//
// RLS: same FORCE + NULLIF guard pattern as every other tenant table.
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  unique,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.table';
import { customers } from './customers.table';
import { conversations } from './conversations.table';
import { storeConnections } from './store-connections.table';

/** Kept in lockstep with migration 0059's `orders_status_check`. Lifecycle diagram: F25 D2.1. */
export const ORDER_STATUSES = [
  'pending_approval',
  'confirmed',
  'rejected',
  'expired',
  'cancelled',
  'fulfilled',
  'failed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Deliberately not part of `ORDER_STATUSES`. The push to a connected store is
 * its own lifecycle (D4): a store outage moves this column, never `status`.
 */
export const ORDER_STORE_SYNC_STATUSES = [
  'not_applicable',
  'pending',
  'synced',
  'failed',
] as const;
export type OrderStoreSyncStatus = (typeof ORDER_STORE_SYNC_STATUSES)[number];

/** Phase 1 is COD only (D3), enforced by a CHECK constraint that physically cannot store another method. */
export const ORDER_PAYMENT_METHODS = ['cod'] as const;
export type OrderPaymentMethod = (typeof ORDER_PAYMENT_METHODS)[number];

export const ORDER_PAYMENT_STATUSES = ['unpaid', 'collected'] as const;
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Short, human-quotable. Generated server-side; never supplied by the model. */
    reference: text('reference').notNull(),
    /** Resolved from the TURN CONTEXT, never from the model's arguments (D2.2). */
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),

    status: text('status').notNull(),

    contactName: text('contact_name').notNull(),
    contactPhone: text('contact_phone').notNull(),
    city: text('city'),
    address: text('address').notNull(),
    notes: text('notes'),

    paymentMethod: text('payment_method').notNull().default('cod'),
    paymentStatus: text('payment_status').notNull().default('unpaid'),

    subtotal: numeric('subtotal', { precision: 12, scale: 2 }).notNull(),
    total: numeric('total', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').notNull(),

    /**
     * Pinned at order-creation time, not re-chosen at push time (D4.4). F24's
     * non-deterministic `connections.find(...)` meant the same order could go
     * to a different store on each run.
     */
    storeConnectionId: uuid('store_connection_id').references(
      () => storeConnections.id,
      { onDelete: 'set null' },
    ),
    storeSyncStatus: text('store_sync_status')
      .notNull()
      .default('not_applicable'),
    externalOrderId: text('external_order_id'),
    /**
     * Persisted (D3) but never sent to the customer: with no payment webhook
     * we could not answer the next question the customer asks.
     */
    storePaymentUrl: text('store_payment_url'),
    storeSyncAttempts: integer('store_sync_attempts').notNull().default(0),
    storeSyncError: text('store_sync_error'),

    /** D6.2: deterministic, derived from the turn. See order-idempotency.ts. */
    idempotencyKey: text('idempotency_key').notNull(),
    /** D6.2: canonical hash of items+contact. Excludes turnId on purpose — that is what makes it catch a DIFFERENT turn ordering the same thing. */
    contentHash: text('content_hash').notNull(),

    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),
    customerNotifiedAt: timestamp('customer_notified_at', {
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique('orders_tenant_id_idempotency_key_unique').on(
      table.tenantId,
      table.idempotencyKey,
    ),
    unique('orders_tenant_id_reference_unique').on(
      table.tenantId,
      table.reference,
    ),
    // Supports order_items' composite FK below: an item cannot be attached to
    // another tenant's order even if an id leaks.
    unique('orders_tenant_id_id_unique').on(table.tenantId, table.id),
    // D6.2 race #3: two racing turns in one conversation cannot open two
    // identical pending orders.
    uniqueIndex('orders_pending_dedup_idx')
      .on(table.tenantId, table.conversationId, table.contentHash)
      .where(sql`"status" = 'pending_approval'`),
    // D4.7: catches a double push.
    uniqueIndex('orders_store_external_id_idx')
      .on(table.tenantId, table.storeConnectionId, table.externalOrderId)
      .where(sql`"external_order_id" is not null`),
    index('orders_tenant_status_created_idx').on(
      table.tenantId,
      table.status,
      table.createdAt.desc(),
    ),
    index('orders_tenant_conversation_idx').on(
      table.tenantId,
      table.conversationId,
    ),
    index('orders_tenant_customer_idx').on(table.tenantId, table.customerId),
  ],
).enableRLS();
