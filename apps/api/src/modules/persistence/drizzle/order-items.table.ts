// F25 (Orders in Chat), D2: the line items of an order, with the price
// SNAPSHOTTED at order time.
//
// The snapshot is the whole point: a price is frozen when the order is placed
// and is NEVER re-read from the catalog. A merchant who raises a price
// tomorrow has not raised the price of yesterday's order, and a product
// deleted next month must not erase order history — hence `product_id` is
// ON DELETE SET NULL, not CASCADE, while `product_name`/`sku`/`unit_price`
// live on the row itself.
//
// RLS: same FORCE + NULLIF guard pattern as every other tenant table.
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  timestamp,
  foreignKey,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';
import { products } from './products.table';
import { orders } from './orders.table';

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').notNull(),
    productId: uuid('product_id').references(() => products.id, {
      onDelete: 'set null',
    }),

    productName: text('product_name').notNull(),
    sku: text('sku'),
    unitPrice: numeric('unit_price', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    quantity: integer('quantity').notNull(),
    lineTotal: numeric('line_total', { precision: 12, scale: 2 }).notNull(),
    /** Resolved at order time, so a later re-sync cannot repoint an already-placed order. */
    externalProductId: text('external_product_id'),
    externalVariantId: text('external_variant_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    /**
     * COMPOSITE, same trick as `customer_labels`. A per-column FK to
     * `orders.id` would let a caller write an item row under THEIR tenant
     * pointing at another tenant's order id: RLS' WITH CHECK only constrains
     * `tenant_id`, and the FK would be satisfied because that order really
     * does exist. (tenant_id, order_id) -> (orders.tenant_id, orders.id)
     * makes that write impossible in the database, not just in a service.
     */
    foreignKey({
      name: 'order_items_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [orders.tenantId, orders.id],
    }).onDelete('cascade'),
    index('order_items_tenant_order_idx').on(table.tenantId, table.orderId),
  ],
).enableRLS();
