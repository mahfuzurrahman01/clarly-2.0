// Feature 24 (Store Integrations): per-tenant store links — OAuth credentials,
// store metadata, and sync state. Supports multiple stores per tenant (Salla
// AND Shopify) via the (tenant_id, provider, store_id) unique constraint.
//
// `access_token` / `refresh_token` / `authorization_token` / `webhook_secret`
// hold AES-256-GCM ciphertext (base64 iv+tag+ct) produced by
// `BspCredentialsEncryptionService` — the same cipher `social_channels.credentials_encrypted` uses. Never write
// a plaintext secret into these columns; StoreConnectionService is the only
// thing that encrypts/decrypts them.
//
// RLS: same FORCE + NULLIF guard pattern as every other tenant table.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './tenants.table';

// Kept in lockstep with migration 0058's `store_connections_provider_check`
// CHECK constraint — the DB is the second barrier, this list is the first.
export const STORE_PROVIDERS = [
  'salla',
  'zid',
  'shopify',
  'woocommerce',
] as const;
export type StoreProviderType = (typeof STORE_PROVIDERS)[number];

export const storeConnections = pgTable(
  'store_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    storeId: text('store_id').notNull(),
    storeName: text('store_name').notNull(),
    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token'),
    // Migration 0066. Zid only: the partner `authorization` token sent as
    // `Authorization: Bearer` next to the manager token (`access_token`).
    authorizationToken: text('authorization_token'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    storeUrl: text('store_url'),
    webhookSecret: text('webhook_secret'),
    isActive: boolean('is_active').notNull().default(true),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique().on(table.tenantId, table.provider, table.storeId),
    index('store_connections_tenant_id_idx').on(table.tenantId),
    index('store_connections_provider_idx').on(table.provider),
  ],
).enableRLS();
