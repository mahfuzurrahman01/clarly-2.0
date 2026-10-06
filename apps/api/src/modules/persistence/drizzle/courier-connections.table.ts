// F26 (Delivery Tracking): per-tenant courier links — encrypted static
// credentials, the merchant's account reference at the courier, and poll
// state.
//
// D1: there is NO OAuth here. All four couriers authenticate with long-lived
// account credentials the merchant pastes into the console, so `credentials`
// holds ONE AES-256-GCM blob (`BspCredentialsEncryptionService`, the same
// cipher and key `social_channels` and `store_connections` use) containing the
// whole provider-specific credential object. Adding a courier never adds a
// column, and there is exactly one crypto path to audit.
//
// `webhook_secret` is also ciphertext, and is null for the three poll-only
// couriers (D1/D6) — we mint one only for couriers whose push signature we
// can actually verify.
//
// RLS: FORCE + the NULLIF guard, same as every other tenant table (D7).
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  unique,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tenants } from './tenants.table';

/**
 * Kept in lockstep with migration 0060's `courier_connections_courier_check`
 * CHECK constraint — the DB is the second barrier, this list is the first.
 */
export const COURIER_NAMES = ['aramex', 'smsa', 'naqel', 'jt'] as const;
export type CourierName = (typeof COURIER_NAMES)[number];

export const courierConnections = pgTable(
  'courier_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    courier: text('courier').notNull(),
    /** AES-256-GCM blob. Never logged, never returned over HTTP. */
    credentials: text('credentials').notNull(),
    /** The merchant's account/shipper reference at the courier. Also the webhook routing key. */
    accountRef: text('account_ref').notNull(),
    /** AES-256-GCM. Minted only for couriers we accept push from; null for poll-only couriers. */
    webhookSecret: text('webhook_secret'),
    isActive: boolean('is_active').notNull().default(false),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.tenantId, table.courier, table.accountRef),
    // The webhook routing key (D6 step 2). Partial on `is_active` so a
    // deactivated connection frees its (courier, account_ref) pair.
    uniqueIndex('courier_connections_routing_key')
      .on(table.courier, table.accountRef)
      .where(sql`"is_active"`),
    index('courier_connections_tenant_id_idx').on(table.tenantId),
  ],
).enableRLS();
