import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

export const CALENDAR_PROVIDERS = ['google'] as const;
export type CalendarProviderName = (typeof CALENDAR_PROVIDERS)[number];

export const CALENDAR_CONNECTION_STATUSES = [
  'active',
  'needs_reconnect',
] as const;
export type CalendarConnectionStatus =
  (typeof CALENDAR_CONNECTION_STATUSES)[number];

/**
 * Clarly 2.0 S2 (migration 0071): one calendar per tenant. The refresh token
 * lives only inside `credentialsEncrypted` (AES-256-GCM, same key and service
 * as channel credentials); no DTO ever returns it.
 */
export const calendarConnections = pgTable('calendar_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .unique('calendar_connections_tenant_unique')
    .references(() => tenants.id, { onDelete: 'cascade' }),
  provider: text('provider').$type<CalendarProviderName>().notNull(),
  accountEmail: text('account_email'),
  calendarId: text('calendar_id').notNull().default('primary'),
  credentialsEncrypted: text('credentials_encrypted').notNull(),
  status: text('status')
    .$type<CalendarConnectionStatus>()
    .notNull()
    .default('active'),
  lastError: text('last_error'),
  connectedBy: uuid('connected_by'),
  /** The OAuth state nonce this connection was completed with: a replayed callback carrying the same nonce is refused. */
  stateNonce: text('state_nonce'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
}).enableRLS();
