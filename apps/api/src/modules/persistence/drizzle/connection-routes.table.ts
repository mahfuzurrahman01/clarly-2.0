import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

/**
 * Migration 0073: which tenant owns a courier account, for courier pushes
 * that arrive with no tenant. NOT RLS-scoped (a routing key, like
 * `whatsapp_numbers`) and holds no secret: the handler learns the tenant
 * here, then loads the connection and its webhook secret under
 * `withTenantTx(tenantId)`. Maintained by CourierConnectionService inside the
 * transaction that activates/deactivates the connection.
 */
export const courierRoutes = pgTable(
  'courier_routes',
  {
    courier: text('courier').notNull(),
    accountRef: text('account_ref').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .unique('courier_routes_connection_unique'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'courier_routes_pkey',
      columns: [table.courier, table.accountRef],
    }),
    index('courier_routes_tenant_idx').on(table.tenantId),
  ],
);

/** Migration 0073: the same, for store webhooks (`provider`, `store_id`). Latest connection wins, matching the previous newest-row rule. */
export const storeRoutes = pgTable(
  'store_routes',
  {
    provider: text('provider').notNull(),
    storeId: text('store_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .unique('store_routes_connection_unique'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'store_routes_pkey',
      columns: [table.provider, table.storeId],
    }),
    index('store_routes_tenant_idx').on(table.tenantId),
  ],
);
